import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { accountSubjects } from "@/platform/database/account-subject-schema";
import {
  creditFinalizationJobs,
  creditGrants,
  creditLedgerEntries,
  creditReservationAllocations,
  creditReservations,
} from "@/platform/database/credit-schema";

import { allocateCredits } from "../domain/allocation";
import {
  assertCreditQuantity,
  assertReservationExpiry,
  assertReservationTerminalTransition,
} from "../domain/invariants";
import type {
  CreditAllocation,
  CreditBalance,
  CreditReservationStatus,
  CreditSource,
} from "../domain/types";

type CreditTx = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

export type CreditReservationRecord = {
  readonly id: string;
  readonly subjectId: string;
  readonly creditType: string;
  readonly purposeType: string;
  readonly purposeId: string;
  readonly quantity: number;
  readonly status: CreditReservationStatus;
  readonly expiresAt: Date;
  readonly allocations: readonly CreditAllocation[];
};

async function ensureActiveSubject(tx: CreditTx, subjectId: string): Promise<void> {
  const subject = await tx.query.accountSubjects.findFirst({
    where: and(eq(accountSubjects.id, subjectId), eq(accountSubjects.status, "active")),
  });
  if (!subject) throw new Error("active account subject is required");
}

async function lockSubjectCreditType(
  tx: CreditTx,
  subjectId: string,
  creditType: string,
): Promise<void> {
  // Hash collisions can only serialize unrelated tuples; every mutation/query remains explicitly scoped
  // by subjectId + creditType, so a collision cannot mix balances or allocations.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${subjectId}:${creditType}`}, 0))`,
  );
}

async function loadAllocations(tx: CreditTx, reservationId: string): Promise<CreditAllocation[]> {
  const rows = await tx
    .select({
      grantId: creditReservationAllocations.grantId,
      quantity: creditReservationAllocations.quantity,
    })
    .from(creditReservationAllocations)
    .where(eq(creditReservationAllocations.reservationId, reservationId));
  return rows;
}

async function loadGrantReductions(
  tx: CreditTx,
  grantIds: readonly string[],
): Promise<Map<string, { consumed: number; expired: number; revoked: number }>> {
  if (grantIds.length === 0) return new Map();
  const rows = await tx
    .select({
      grantId: creditLedgerEntries.grantId,
      entryType: creditLedgerEntries.entryType,
      total: sql<number>`coalesce(sum(${creditLedgerEntries.quantity}), 0)::int`,
    })
    .from(creditLedgerEntries)
    .where(
      and(
        inArray(creditLedgerEntries.grantId, [...grantIds]),
        inArray(creditLedgerEntries.entryType, ["consume", "expire", "revoke", "adjust_negative"]),
      ),
    )
    .groupBy(creditLedgerEntries.grantId, creditLedgerEntries.entryType);

  const result = new Map<string, { consumed: number; expired: number; revoked: number }>();
  for (const id of grantIds) result.set(id, { consumed: 0, expired: 0, revoked: 0 });
  for (const row of rows) {
    if (!row.grantId) continue;
    const current = result.get(row.grantId) ?? { consumed: 0, expired: 0, revoked: 0 };
    const total = Number(row.total);
    if (row.entryType === "consume") current.consumed += total;
    else if (row.entryType === "expire") current.expired += total;
    else current.revoked += total;
    result.set(row.grantId, current);
  }
  return result;
}

async function loadActiveReserved(
  tx: CreditTx,
  grantIds: readonly string[],
  now: Date,
): Promise<Map<string, number>> {
  if (grantIds.length === 0) return new Map();
  const rows = await tx
    .select({
      grantId: creditReservationAllocations.grantId,
      total: sql<number>`coalesce(sum(${creditReservationAllocations.quantity}), 0)::int`,
    })
    .from(creditReservationAllocations)
    .innerJoin(
      creditReservations,
      eq(creditReservations.id, creditReservationAllocations.reservationId),
    )
    .where(
      and(
        inArray(creditReservationAllocations.grantId, [...grantIds]),
        eq(creditReservations.status, "active"),
        sql`${creditReservations.expiresAt} > ${now}`,
      ),
    )
    .groupBy(creditReservationAllocations.grantId);
  return new Map(rows.map((row) => [row.grantId, Number(row.total)]));
}

async function reservationRecord(tx: CreditTx, id: string): Promise<CreditReservationRecord> {
  const reservation = await tx.query.creditReservations.findFirst({
    where: eq(creditReservations.id, id),
  });
  if (!reservation) throw new Error("credit reservation not found");
  return {
    id: reservation.id,
    subjectId: reservation.subjectId,
    creditType: reservation.creditType,
    purposeType: reservation.purposeType,
    purposeId: reservation.purposeId,
    quantity: reservation.quantity,
    status: reservation.status as CreditReservationStatus,
    expiresAt: reservation.expiresAt,
    allocations: await loadAllocations(tx, reservation.id),
  };
}

export async function grantCredits(
  database: DatabaseClient,
  input: {
    readonly subjectId: string;
    readonly creditType: string;
    readonly quantity: number;
    readonly source: CreditSource;
    readonly idempotencyKey: string;
    readonly expiresAt: Date | null;
    readonly actor: "system" | "operator";
    readonly metadata?: Record<string, unknown>;
  },
) {
  assertCreditQuantity(input.quantity);
  if (!input.creditType.trim() || !input.source.id.trim() || !input.idempotencyKey.trim()) {
    throw new Error("credit grant identifiers are required");
  }

  return database.transaction(async (tx) => {
    await ensureActiveSubject(tx, input.subjectId);
    await lockSubjectCreditType(tx, input.subjectId, input.creditType);

    const bySource = await tx.query.creditGrants.findFirst({
      where: and(
        eq(creditGrants.creditType, input.creditType),
        eq(creditGrants.sourceType, input.source.type),
        eq(creditGrants.sourceId, input.source.id),
      ),
    });
    const byIdempotency = await tx.query.creditGrants.findFirst({
      where: eq(creditGrants.idempotencyKey, input.idempotencyKey),
    });
    const existing = bySource ?? byIdempotency;
    if (bySource && byIdempotency && bySource.id !== byIdempotency.id) {
      throw new Error("credit grant idempotency collision");
    }
    if (existing) {
      if (
        existing.subjectId !== input.subjectId ||
        existing.creditType !== input.creditType ||
        existing.sourceType !== input.source.type ||
        existing.sourceId !== input.source.id ||
        existing.quantity !== input.quantity ||
        existing.idempotencyKey !== input.idempotencyKey ||
        existing.expiresAt?.getTime() !== input.expiresAt?.getTime()
      ) {
        throw new Error("credit grant conflict");
      }
      return existing;
    }

    const [grant] = await tx
      .insert(creditGrants)
      .values({
        subjectId: input.subjectId,
        creditType: input.creditType,
        sourceType: input.source.type,
        sourceId: input.source.id,
        quantity: input.quantity,
        idempotencyKey: input.idempotencyKey,
        expiresAt: input.expiresAt,
        metadataJson: input.metadata ?? {},
      })
      .returning();
    if (!grant) throw new Error("credit grant insert failed");

    await tx.insert(creditLedgerEntries).values({
      subjectId: input.subjectId,
      creditType: input.creditType,
      grantId: grant.id,
      entryType: "grant",
      quantity: input.quantity,
      sourceType: input.source.type,
      sourceId: input.source.id,
      correlationId: input.idempotencyKey,
      idempotencyKey: `grant:${input.idempotencyKey}`,
      actorType: input.actor,
      metadataJson: input.metadata ?? {},
    });
    return grant;
  });
}

export async function getCreditBalance(
  database: DatabaseClient,
  input: { readonly subjectId: string; readonly creditType: string; readonly now?: Date },
): Promise<CreditBalance> {
  const now = input.now ?? new Date();
  return database.transaction(async (tx) => {
    const grants = await tx
      .select()
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.subjectId, input.subjectId),
          eq(creditGrants.creditType, input.creditType),
        ),
      );
    const ids = grants.map((grant) => grant.id);
    const reductions = await loadGrantReductions(tx, ids);
    const reserved = await loadActiveReserved(tx, ids, now);

    let available = 0;
    let reservedTotal = 0;
    let consumed = 0;
    let expired = 0;
    let revoked = 0;

    for (const grant of grants) {
      const reduction = reductions.get(grant.id) ?? { consumed: 0, expired: 0, revoked: 0 };
      const activeReserved = reserved.get(grant.id) ?? 0;
      consumed += reduction.consumed;
      revoked += reduction.revoked;
      const remainingAfterTerminal = Math.max(
        0,
        grant.quantity - reduction.consumed - reduction.expired - reduction.revoked,
      );
      const timeExpired = Boolean(grant.expiresAt && grant.expiresAt <= now);
      if (timeExpired) {
        expired += reduction.expired + remainingAfterTerminal;
      } else {
        expired += reduction.expired;
        reservedTotal += activeReserved;
        available += Math.max(0, remainingAfterTerminal - activeReserved);
      }
    }
    return { available, reserved: reservedTotal, consumed, expired, revoked };
  });
}

export async function reserveCredits(
  database: DatabaseClient,
  input: {
    readonly subjectId: string;
    readonly creditType: string;
    readonly quantity: number;
    readonly purpose: { readonly type: string; readonly id: string };
    readonly idempotencyKey: string;
    readonly expiresAt: Date;
    readonly now?: Date;
  },
): Promise<CreditReservationRecord> {
  const now = input.now ?? new Date();
  assertCreditQuantity(input.quantity);
  assertReservationExpiry(input.expiresAt, now);

  return database.transaction(async (tx) => {
    await ensureActiveSubject(tx, input.subjectId);
    await lockSubjectCreditType(tx, input.subjectId, input.creditType);

    const existing = await tx.query.creditReservations.findFirst({
      where: or(
        and(
          eq(creditReservations.subjectId, input.subjectId),
          eq(creditReservations.creditType, input.creditType),
          eq(creditReservations.purposeType, input.purpose.type),
          eq(creditReservations.purposeId, input.purpose.id),
        ),
        eq(creditReservations.idempotencyKey, input.idempotencyKey),
      ),
    });
    if (existing) {
      if (
        existing.subjectId !== input.subjectId ||
        existing.creditType !== input.creditType ||
        existing.purposeType !== input.purpose.type ||
        existing.purposeId !== input.purpose.id ||
        existing.quantity !== input.quantity ||
        existing.idempotencyKey !== input.idempotencyKey ||
        existing.expiresAt.getTime() !== input.expiresAt.getTime()
      ) {
        throw new Error("credit reservation conflict");
      }
      return reservationRecord(tx, existing.id);
    }

    const grants = await tx
      .select()
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.subjectId, input.subjectId),
          eq(creditGrants.creditType, input.creditType),
          eq(creditGrants.state, "active"),
          or(isNull(creditGrants.expiresAt), sql`${creditGrants.expiresAt} >= ${input.expiresAt}`),
        ),
      )
      .for("update");
    const ids = grants.map((grant) => grant.id);
    const reductions = await loadGrantReductions(tx, ids);
    const reserved = await loadActiveReserved(tx, ids, now);
    const allocation = allocateCredits(
      grants.map((grant) => {
        const reduction = reductions.get(grant.id) ?? { consumed: 0, expired: 0, revoked: 0 };
        return {
          id: grant.id,
          grantedAt: grant.grantedAt,
          expiresAt: grant.expiresAt,
          available: Math.max(
            0,
            grant.quantity -
              reduction.consumed -
              reduction.expired -
              reduction.revoked -
              (reserved.get(grant.id) ?? 0),
          ),
        };
      }),
      input.quantity,
      now,
    );

    const [reservation] = await tx
      .insert(creditReservations)
      .values({
        subjectId: input.subjectId,
        creditType: input.creditType,
        purposeType: input.purpose.type,
        purposeId: input.purpose.id,
        quantity: input.quantity,
        idempotencyKey: input.idempotencyKey,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!reservation) throw new Error("credit reservation insert failed");

    const allocatedTotal = allocation.reduce((sum, item) => sum + item.quantity, 0);
    if (allocatedTotal !== input.quantity) throw new Error("credit allocation invariant failed");
    for (const item of allocation) {
      await tx.insert(creditReservationAllocations).values({
        reservationId: reservation.id,
        grantId: item.grantId,
        quantity: item.quantity,
      });
      await tx.insert(creditLedgerEntries).values({
        subjectId: input.subjectId,
        creditType: input.creditType,
        grantId: item.grantId,
        reservationId: reservation.id,
        entryType: "reserve",
        quantity: item.quantity,
        sourceType: "reservation",
        sourceId: reservation.id,
        correlationId: input.idempotencyKey,
        idempotencyKey: `reserve:${reservation.id}:${item.grantId}`,
        actorType: "system",
      });
    }
    return reservationRecord(tx, reservation.id);
  });
}

async function terminalReservation(
  database: DatabaseClient,
  input: {
    readonly reservationId: string;
    readonly correlationId: string;
    readonly target: "committed" | "released" | "expired";
    readonly now?: Date;
    readonly reason?: string;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await database.transaction(async (tx) => {
    const [reservation] = await tx
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, input.reservationId))
      .limit(1)
      .for("update");
    if (!reservation) throw new Error("credit reservation not found");
    await lockSubjectCreditType(tx, reservation.subjectId, reservation.creditType);
    const current = reservation.status as CreditReservationStatus;
    if (current === input.target) {
      if (reservation.terminalCorrelationId !== input.correlationId) {
        throw new Error("credit reservation terminal correlation conflict");
      }
      return;
    }
    assertReservationTerminalTransition(current, input.target);

    const allocations = await loadAllocations(tx, reservation.id);
    if (allocations.reduce((sum, item) => sum + item.quantity, 0) !== reservation.quantity) {
      throw new Error("credit reservation allocation invariant failed");
    }
    const entryType = input.target === "committed" ? "consume" : "release";
    for (const allocation of allocations) {
      await tx
        .insert(creditLedgerEntries)
        .values({
          subjectId: reservation.subjectId,
          creditType: reservation.creditType,
          grantId: allocation.grantId,
          reservationId: reservation.id,
          entryType,
          quantity: allocation.quantity,
          sourceType: "reservation",
          sourceId: reservation.id,
          correlationId: input.correlationId,
          idempotencyKey: `${entryType}:${reservation.id}:${allocation.grantId}:${input.correlationId}`,
          actorType: "system",
          metadataJson: input.reason ? { reason: input.reason } : {},
        })
        .onConflictDoNothing({ target: creditLedgerEntries.idempotencyKey });
    }

    await tx
      .update(creditReservations)
      .set({
        status: input.target,
        terminalCorrelationId: input.correlationId,
        ...(input.target === "committed" ? { committedAt: now } : {}),
        ...(input.target === "released" ? { releasedAt: now } : {}),
        ...(input.target === "expired" ? { expiredAt: now } : {}),
      })
      .where(eq(creditReservations.id, reservation.id));
  });
}

export async function commitReservation(
  database: DatabaseClient,
  input: { readonly reservationId: string; readonly correlationId: string; readonly now?: Date },
): Promise<void> {
  return terminalReservation(database, { ...input, target: "committed" });
}

export async function releaseReservation(
  database: DatabaseClient,
  input: {
    readonly reservationId: string;
    readonly correlationId: string;
    readonly reason: string;
    readonly now?: Date;
  },
): Promise<void> {
  return terminalReservation(database, { ...input, target: "released" });
}

export async function expireReservations(
  database: DatabaseClient,
  input: { readonly now?: Date; readonly limit?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const rows = await database
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(and(eq(creditReservations.status, "active"), lte(creditReservations.expiresAt, now)))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  let expired = 0;
  for (const row of rows) {
    await terminalReservation(database, {
      reservationId: row.id,
      correlationId: `reservation-expiry:${row.id}:${now.toISOString()}`,
      target: "expired",
      reason: "reservation_expired",
      now,
    });
    expired += 1;
  }
  return expired;
}

export async function expireGrants(
  database: DatabaseClient,
  input: { readonly now?: Date; readonly limit?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const candidates = await database
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.state, "active"),
        sql`${creditGrants.expiresAt} is not null`,
        lte(creditGrants.expiresAt, now),
      ),
    )
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  let count = 0;
  for (const candidate of candidates) {
    await database.transaction(async (tx) => {
      const [grant] = await tx
        .select()
        .from(creditGrants)
        .where(eq(creditGrants.id, candidate.id))
        .limit(1)
        .for("update");
      if (!grant || grant.state !== "active" || !grant.expiresAt || grant.expiresAt > now) return;
      await lockSubjectCreditType(tx, grant.subjectId, grant.creditType);
      const reductions = await loadGrantReductions(tx, [grant.id]);
      const activeReserved = await loadActiveReserved(tx, [grant.id], now);
      if ((activeReserved.get(grant.id) ?? 0) > 0) {
        throw new Error("expired grant still has active reservation");
      }
      const reduction = reductions.get(grant.id) ?? { consumed: 0, expired: 0, revoked: 0 };
      const unused = Math.max(
        0,
        grant.quantity - reduction.consumed - reduction.expired - reduction.revoked,
      );
      if (unused > 0) {
        await tx.insert(creditLedgerEntries).values({
          subjectId: grant.subjectId,
          creditType: grant.creditType,
          grantId: grant.id,
          entryType: "expire",
          quantity: unused,
          sourceType: grant.sourceType,
          sourceId: grant.sourceId,
          correlationId: `grant-expiry:${grant.id}`,
          idempotencyKey: `expire:${grant.id}`,
          actorType: "system",
        });
      }
      await tx.update(creditGrants).set({ state: "expired" }).where(eq(creditGrants.id, grant.id));
      count += 1;
    });
  }
  return count;
}

export async function revokeSourceCredits(
  database: DatabaseClient,
  input: {
    readonly source: CreditSource;
    readonly quantity?: number;
    readonly partialPolicy?: "proportional_floor";
    readonly correlationId: string;
    readonly actor?: "system" | "operator";
    readonly now?: Date;
  },
): Promise<{ readonly revoked: number; readonly blocked: number }> {
  if (input.quantity !== undefined) {
    assertCreditQuantity(input.quantity);
    if (!input.partialPolicy)
      throw new Error("partial credit reversal requires operator-reviewed policy");
  }
  const now = input.now ?? new Date();
  const grants = await database
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.sourceType, input.source.type),
        eq(creditGrants.sourceId, input.source.id),
      ),
    );
  if (grants.length === 0) return { revoked: 0, blocked: input.quantity ?? 0 };

  let targetRemaining = input.quantity ?? Number.MAX_SAFE_INTEGER;
  let revoked = 0;
  let blocked = 0;
  for (const candidate of grants) {
    if (targetRemaining <= 0) break;
    await database.transaction(async (tx) => {
      const [grant] = await tx
        .select()
        .from(creditGrants)
        .where(eq(creditGrants.id, candidate.id))
        .limit(1)
        .for("update");
      if (!grant) return;
      await lockSubjectCreditType(tx, grant.subjectId, grant.creditType);
      const reductions = await loadGrantReductions(tx, [grant.id]);
      const activeReserved = await loadActiveReserved(tx, [grant.id], now);
      const reduction = reductions.get(grant.id) ?? { consumed: 0, expired: 0, revoked: 0 };
      const reserved = activeReserved.get(grant.id) ?? 0;
      const unused = Math.max(
        0,
        grant.quantity - reduction.consumed - reduction.expired - reduction.revoked - reserved,
      );
      const desired = Math.min(unused, targetRemaining);
      if (desired > 0) {
        await tx
          .insert(creditLedgerEntries)
          .values({
            subjectId: grant.subjectId,
            creditType: grant.creditType,
            grantId: grant.id,
            entryType: "revoke",
            quantity: desired,
            sourceType: input.source.type,
            sourceId: input.source.id,
            correlationId: input.correlationId,
            idempotencyKey: `revoke:${input.correlationId}:${grant.id}`,
            actorType: input.actor ?? "system",
            metadataJson: input.partialPolicy ? { partialPolicy: input.partialPolicy } : {},
          })
          .onConflictDoNothing({ target: creditLedgerEntries.idempotencyKey });
        revoked += desired;
        targetRemaining -= desired;
      }
      const irrecoverable = reduction.consumed + reserved;
      blocked += Math.min(irrecoverable, Math.max(0, targetRemaining));
      if (desired === unused && unused > 0 && reduction.consumed + reserved === 0) {
        await tx
          .update(creditGrants)
          .set({ state: "revoked" })
          .where(eq(creditGrants.id, grant.id));
      }
    });
  }
  if (input.quantity !== undefined && revoked < input.quantity) blocked = input.quantity - revoked;
  return { revoked, blocked };
}

export async function enqueueCreditFinalization(
  database: DatabaseClient,
  input: { readonly reservationId: string; readonly deliveryReference: string },
): Promise<void> {
  await database
    .insert(creditFinalizationJobs)
    .values({ reservationId: input.reservationId, deliveryReference: input.deliveryReference })
    .onConflictDoNothing({ target: creditFinalizationJobs.reservationId });
}

export async function withCreditReservation<T>(
  database: DatabaseClient,
  input: Parameters<typeof reserveCredits>[1],
  callbacks: {
    readonly work: (reservation: CreditReservationRecord) => Promise<T>;
    readonly persistDelivery: (
      result: T,
      reservation: CreditReservationRecord,
    ) => Promise<{ readonly deliveryReference: string }>;
  },
): Promise<{ readonly result: T; readonly finalizationPending: boolean }> {
  const reservation = await reserveCredits(database, input);
  let result: T;
  try {
    result = await callbacks.work(reservation);
  } catch (error) {
    await releaseReservation(database, {
      reservationId: reservation.id,
      correlationId: `work-failed:${reservation.id}`,
      reason: "product_work_failed",
    });
    throw error;
  }

  const delivery = await callbacks.persistDelivery(result, reservation);
  try {
    await commitReservation(database, {
      reservationId: reservation.id,
      correlationId: `delivery:${delivery.deliveryReference}`,
    });
    return { result, finalizationPending: false };
  } catch {
    await enqueueCreditFinalization(database, {
      reservationId: reservation.id,
      deliveryReference: delivery.deliveryReference,
    });
    return { result, finalizationPending: true };
  }
}
