import { and, asc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
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
import type { CreditReservationStatus } from "../domain/types";
import { withCreditMutationLock } from "../infrastructure/credit-lock";
import {
  assertGrantQuantityInvariant,
  ensureActiveSubject,
  loadActiveReserved,
  loadAllocations,
  loadGrantReductions,
  maybeMarkExpiredGrantTerminal,
  reservationRecord,
  type CreditReservationRecord,
} from "./internal/credit-support";

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

  return database.transaction((tx) =>
    withCreditMutationLock({
      tx,
      subjectId: input.subjectId,
      creditType: input.creditType,
      run: async () => {
        await ensureActiveSubject(tx, input.subjectId);

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
              or(isNull(creditGrants.expiresAt), gt(creditGrants.expiresAt, now)),
            ),
          )
          .orderBy(asc(creditGrants.id))
          .for("update");
        const ids = grants.map((grant) => grant.id);
        const reductions = await loadGrantReductions(tx, ids);
        const reserved = await loadActiveReserved(tx, ids);
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
        if (allocatedTotal !== input.quantity)
          throw new Error("credit allocation invariant failed");
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
        await assertGrantQuantityInvariant(tx, ids);
        return reservationRecord(tx, reservation.id);
      },
    }),
  );
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
  const scope = await database.query.creditReservations.findFirst({
    columns: { subjectId: true, creditType: true },
    where: eq(creditReservations.id, input.reservationId),
  });
  if (!scope) throw new Error("credit reservation not found");

  await database.transaction((tx) =>
    withCreditMutationLock({
      tx,
      subjectId: scope.subjectId,
      creditType: scope.creditType,
      run: async () => {
        const [reservation] = await tx
          .select()
          .from(creditReservations)
          .where(eq(creditReservations.id, input.reservationId))
          .limit(1)
          .for("update");
        if (!reservation) throw new Error("credit reservation not found");
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
        const grantIds = allocations.map((allocation) => allocation.grantId);
        const grants = grantIds.length
          ? await tx
              .select()
              .from(creditGrants)
              .where(inArray(creditGrants.id, grantIds))
              .orderBy(asc(creditGrants.id))
              .for("update")
          : [];
        const grantById = new Map(grants.map((grant) => [grant.id, grant]));
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

          if (entryType === "release") {
            const grant = grantById.get(allocation.grantId);
            if (grant?.expiresAt && grant.expiresAt <= now) {
              await tx
                .insert(creditLedgerEntries)
                .values({
                  subjectId: reservation.subjectId,
                  creditType: reservation.creditType,
                  grantId: allocation.grantId,
                  reservationId: reservation.id,
                  entryType: "expire",
                  quantity: allocation.quantity,
                  sourceType: grant.sourceType,
                  sourceId: grant.sourceId,
                  correlationId: `post-expiry-${input.target}:${reservation.id}`,
                  idempotencyKey: `expire:${input.target}:${reservation.id}:${allocation.grantId}`,
                  actorType: "system",
                  metadataJson: { reason: "released_after_source_expiry" },
                })
                .onConflictDoNothing({ target: creditLedgerEntries.idempotencyKey });
            }
          }
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

        await assertGrantQuantityInvariant(tx, grantIds);
        for (const grantId of grantIds) await maybeMarkExpiredGrantTerminal(tx, grantId, now);
      },
    }),
  );
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
    .orderBy(asc(creditReservations.id))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  let expired = 0;
  for (const row of rows) {
    try {
      await terminalReservation(database, {
        reservationId: row.id,
        correlationId: `reservation-expiry:${row.id}`,
        target: "expired",
        reason: "reservation_expired",
        now,
      });
      expired += 1;
    } catch (error) {
      const current = await database.query.creditReservations.findFirst({
        columns: { status: true },
        where: eq(creditReservations.id, row.id),
      });
      if (current?.status === "committed" || current?.status === "released") continue;
      throw error;
    }
  }
  return expired;
}
