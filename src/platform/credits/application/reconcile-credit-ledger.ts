import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
  creditGrants,
  creditLedgerEntries,
  creditReservationAllocations,
  creditReservations,
} from "@/platform/database/credit-schema";
import { platformMeta } from "@/platform/database/schema";

import { getGrantQuantityProjections } from "./credit-service";

export type CreditReconciliationIssue = {
  readonly code: string;
  readonly entityId: string;
  readonly detail: string;
};

type CreditTx = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

const RECONCILIATION_CHECKPOINT_KEY = "credits.reconciliation.cursor.v1";
const RECONCILIATION_LOCK_KEY = "creat-web:credits:reconciliation";

export type CreditReconciliationCursor = Readonly<{
  readonly phase: "reservations" | "grants";
  readonly afterId: string | null;
}>;

export type CreditReconciliationEntity = Readonly<{
  readonly kind: "reservation" | "grant";
  readonly id: string;
}>;

export type CreditReconciliationBatch = Readonly<{
  readonly issues: readonly CreditReconciliationIssue[];
  readonly processed: number;
  readonly processedEntities: readonly CreditReconciliationEntity[];
  readonly cursor: CreditReconciliationCursor;
  readonly cycleComplete: boolean;
}>;

export type CreditReconciliationBatchInput = Readonly<{
  readonly limit: number;
  readonly now?: Date;
  readonly signal?: AbortSignal;
  readonly canContinue?: (minimumRemainingMs?: number) => boolean;
}>;

type ReservationBatchRow = {
  readonly id: string;
  readonly quantity: number;
  readonly status: string;
  readonly expiresAt: Date;
};

type GrantBatchRow = {
  readonly id: string;
  readonly quantity: number;
  readonly state: string;
};

const INITIAL_RECONCILIATION_CURSOR: CreditReconciliationCursor = {
  phase: "reservations",
  afterId: null,
};

function assertBatchCanContinue(input: CreditReconciliationBatchInput): void {
  if (input.signal?.aborted) throw new Error("credit reconciliation batch aborted");
  if (input.canContinue && !input.canContinue(1)) {
    throw new Error("credit reconciliation batch budget exhausted");
  }
}

function parseReconciliationCursor(value: string): CreditReconciliationCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("credit reconciliation checkpoint is invalid");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("phase" in parsed) ||
    (parsed.phase !== "reservations" && parsed.phase !== "grants") ||
    !("afterId" in parsed) ||
    (parsed.afterId !== null && typeof parsed.afterId !== "string")
  ) {
    throw new Error("credit reconciliation checkpoint is invalid");
  }
  return {
    phase: parsed.phase,
    afterId: parsed.afterId,
  };
}

async function loadReconciliationCursor(tx: CreditTx): Promise<CreditReconciliationCursor> {
  await tx
    .insert(platformMeta)
    .values({
      key: RECONCILIATION_CHECKPOINT_KEY,
      value: JSON.stringify(INITIAL_RECONCILIATION_CURSOR),
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ value: platformMeta.value })
    .from(platformMeta)
    .where(eq(platformMeta.key, RECONCILIATION_CHECKPOINT_KEY))
    .for("update");
  if (!row) throw new Error("credit reconciliation checkpoint is unavailable");
  return parseReconciliationCursor(row.value);
}

async function saveReconciliationCursor(
  tx: CreditTx,
  cursor: CreditReconciliationCursor,
): Promise<void> {
  await tx
    .update(platformMeta)
    .set({ value: JSON.stringify(cursor), updatedAt: new Date() })
    .where(eq(platformMeta.key, RECONCILIATION_CHECKPOINT_KEY));
}

async function reconcileReservationBatch(
  tx: CreditTx,
  reservations: readonly ReservationBatchRow[],
  now: Date,
  input: CreditReconciliationBatchInput,
): Promise<{
  readonly issues: readonly CreditReconciliationIssue[];
  readonly entities: readonly CreditReconciliationEntity[];
}> {
  if (reservations.length === 0) return { issues: [], entities: [] };
  const reservationIds = reservations.map((reservation) => reservation.id);
  const allocationTotals = await tx
    .select({
      reservationId: creditReservationAllocations.reservationId,
      total: sql<number>`coalesce(sum(${creditReservationAllocations.quantity}), 0)::int`,
    })
    .from(creditReservationAllocations)
    .where(inArray(creditReservationAllocations.reservationId, reservationIds))
    .groupBy(creditReservationAllocations.reservationId);
  assertBatchCanContinue(input);

  const allocationChecks = await tx
    .select({
      reservationId: creditReservationAllocations.reservationId,
      crossSubjectGrantId: sql<
        string | null
      >`min(${creditGrants.id}::text) filter (where ${creditReservations.subjectId} <> ${creditGrants.subjectId})`,
      crossTypeGrantId: sql<
        string | null
      >`min(${creditGrants.id}::text) filter (where ${creditReservations.creditType} <> ${creditGrants.creditType})`,
    })
    .from(creditReservationAllocations)
    .innerJoin(
      creditReservations,
      eq(creditReservations.id, creditReservationAllocations.reservationId),
    )
    .innerJoin(creditGrants, eq(creditGrants.id, creditReservationAllocations.grantId))
    .where(inArray(creditReservationAllocations.reservationId, reservationIds))
    .groupBy(creditReservationAllocations.reservationId);
  assertBatchCanContinue(input);

  const missingTerminalEntries = await tx
    .select({ id: creditReservations.id, status: creditReservations.status })
    .from(creditReservations)
    .where(
      and(
        inArray(creditReservations.id, reservationIds),
        sql`${creditReservations.status} in ('committed','released','expired')`,
        sql`not exists (
          select 1 from ${creditLedgerEntries}
          where ${creditLedgerEntries.reservationId} = ${creditReservations.id}
            and ${creditLedgerEntries.entryType} in ('consume','release')
        )`,
      ),
    );
  const allocationByReservation = new Map(
    allocationTotals.map((row) => [row.reservationId, Number(row.total)]),
  );
  const allocationChecksByReservation = new Map(
    allocationChecks.map((row) => [row.reservationId, row]),
  );
  const missingTerminalIds = new Set(missingTerminalEntries.map((row) => row.id));
  const issues: CreditReconciliationIssue[] = [];

  for (const reservation of reservations) {
    assertBatchCanContinue(input);
    const allocated = allocationByReservation.get(reservation.id) ?? 0;
    if (allocated !== reservation.quantity) {
      issues.push({
        code: "RESERVATION_ALLOCATION_MISMATCH",
        entityId: reservation.id,
        detail: `reserved=${reservation.quantity} allocated=${allocated}`,
      });
    }
    if (reservation.status === "active" && reservation.expiresAt <= now) {
      issues.push({
        code: "STALE_ACTIVE_RESERVATION",
        entityId: reservation.id,
        detail: reservation.expiresAt.toISOString(),
      });
    }
    const checks = allocationChecksByReservation.get(reservation.id);
    if (checks?.crossSubjectGrantId) {
      issues.push({
        code: "CROSS_SUBJECT_ALLOCATION",
        entityId: reservation.id,
        detail: checks.crossSubjectGrantId,
      });
    }
    if (checks?.crossTypeGrantId) {
      issues.push({
        code: "CROSS_CREDIT_TYPE_ALLOCATION",
        entityId: reservation.id,
        detail: checks.crossTypeGrantId,
      });
    }
    if (missingTerminalIds.has(reservation.id)) {
      issues.push({
        code: "TERMINAL_RESERVATION_WITHOUT_LEDGER",
        entityId: reservation.id,
        detail: reservation.status,
      });
    }
  }

  return {
    issues,
    entities: reservations.map((reservation) => ({ kind: "reservation", id: reservation.id })),
  };
}

async function reconcileGrantBatch(
  tx: CreditTx,
  grants: readonly GrantBatchRow[],
  input: CreditReconciliationBatchInput,
): Promise<{
  readonly issues: readonly CreditReconciliationIssue[];
  readonly entities: readonly CreditReconciliationEntity[];
}> {
  if (grants.length === 0) return { issues: [], entities: [] };
  const grantIds = grants.map((grant) => grant.id);
  const ledgerTotals = await tx
    .select({
      grantId: creditLedgerEntries.grantId,
      grant: sql<number>`coalesce(sum(case when ${creditLedgerEntries.entryType} = 'grant' then ${creditLedgerEntries.quantity} else 0 end), 0)::int`,
      consumed: sql<number>`coalesce(sum(case when ${creditLedgerEntries.entryType} = 'consume' then ${creditLedgerEntries.quantity} else 0 end), 0)::int`,
      expired: sql<number>`coalesce(sum(case when ${creditLedgerEntries.entryType} = 'expire' then ${creditLedgerEntries.quantity} else 0 end), 0)::int`,
      revoked: sql<number>`coalesce(sum(case when ${creditLedgerEntries.entryType} in ('revoke','adjust_negative') then ${creditLedgerEntries.quantity} else 0 end), 0)::int`,
    })
    .from(creditLedgerEntries)
    .where(inArray(creditLedgerEntries.grantId, grantIds))
    .groupBy(creditLedgerEntries.grantId);
  assertBatchCanContinue(input);

  const activeReservations = await tx
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
        inArray(creditReservationAllocations.grantId, grantIds),
        eq(creditReservations.status, "active"),
      ),
    )
    .groupBy(creditReservationAllocations.grantId);
  const ledgerByGrant = new Map(ledgerTotals.map((row) => [row.grantId, row]));
  const reservedByGrant = new Map(
    activeReservations.map((row) => [row.grantId, Number(row.total)]),
  );
  const issues: CreditReconciliationIssue[] = [];

  for (const grant of grants) {
    assertBatchCanContinue(input);
    const totals = ledgerByGrant.get(grant.id);
    const grantTotal = Number(totals?.grant ?? 0);
    const consumed = Number(totals?.consumed ?? 0);
    const expired = Number(totals?.expired ?? 0);
    const revoked = Number(totals?.revoked ?? 0);
    const activeReserved = reservedByGrant.get(grant.id) ?? 0;
    if (grantTotal !== grant.quantity) {
      issues.push({
        code: "GRANT_LEDGER_MISMATCH",
        entityId: grant.id,
        detail: `grant=${grant.quantity} ledger=${grantTotal}`,
      });
    }
    const terminal = consumed + expired + revoked;
    if (terminal > grant.quantity) {
      issues.push({
        code: "GRANT_OVERDRAWN",
        entityId: grant.id,
        detail: `quantity=${grant.quantity} terminal=${terminal}`,
      });
    }
    if (grant.state === "expired" && expired === 0 && terminal < grant.quantity) {
      issues.push({
        code: "EXPIRED_GRANT_WITHOUT_EXPIRY_ENTRY",
        entityId: grant.id,
        detail: `remaining=${grant.quantity - terminal}`,
      });
    }
    const available = grant.quantity - terminal - activeReserved;
    if (available < 0) {
      issues.push({
        code: "GRANT_QUANTITY_INVARIANT",
        entityId: grant.id,
        detail: `quantity=${grant.quantity} conserved=${terminal + activeReserved + available}`,
      });
    }
  }

  return {
    issues,
    entities: grants.map((grant) => ({ kind: "grant", id: grant.id })),
  };
}

export async function reconcileCreditLedgerBatch(
  database: DatabaseClient,
  input: CreditReconciliationBatchInput,
): Promise<CreditReconciliationBatch> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new Error("credit reconciliation batch limit must be an integer between 1 and 500");
  }
  assertBatchCanContinue(input);
  const now = input.now ?? new Date();

  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${RECONCILIATION_LOCK_KEY}))`);
    const initialCursor = await loadReconciliationCursor(tx);
    let phase = initialCursor.phase;
    let afterId = initialCursor.afterId;
    let processed = 0;
    let cycleComplete = false;
    let phasesVisited = 0;
    const issues: CreditReconciliationIssue[] = [];
    const processedEntities: CreditReconciliationEntity[] = [];
    let nextCursor: CreditReconciliationCursor = initialCursor;

    while (processed < input.limit && phasesVisited < 2) {
      assertBatchCanContinue(input);
      const remaining = input.limit - processed;
      if (phase === "reservations") {
        const reservations = (await tx
          .select({
            id: creditReservations.id,
            quantity: creditReservations.quantity,
            status: creditReservations.status,
            expiresAt: creditReservations.expiresAt,
          })
          .from(creditReservations)
          .where(afterId ? gt(creditReservations.id, afterId) : sql`true`)
          .orderBy(asc(creditReservations.id))
          .limit(remaining)) as ReservationBatchRow[];
        const result = await reconcileReservationBatch(tx, reservations, now, input);
        issues.push(...result.issues);
        processedEntities.push(...result.entities);
        processed += reservations.length;
        if (reservations.length === remaining) {
          const last = reservations[reservations.length - 1];
          if (!last) throw new Error("credit reconciliation reservation cursor failed");
          nextCursor = { phase, afterId: last.id };
          break;
        }
        phase = "grants";
        afterId = null;
        nextCursor = { phase, afterId };
        phasesVisited += 1;
        if (reservations.length === 0 && phasesVisited === 2) cycleComplete = true;
        continue;
      }

      const grants = (await tx
        .select({
          id: creditGrants.id,
          quantity: creditGrants.quantity,
          state: creditGrants.state,
        })
        .from(creditGrants)
        .where(afterId ? gt(creditGrants.id, afterId) : sql`true`)
        .orderBy(asc(creditGrants.id))
        .limit(remaining)) as GrantBatchRow[];
      const result = await reconcileGrantBatch(tx, grants, input);
      issues.push(...result.issues);
      processedEntities.push(...result.entities);
      processed += grants.length;
      if (grants.length === remaining) {
        const last = grants[grants.length - 1];
        if (!last) throw new Error("credit reconciliation grant cursor failed");
        nextCursor = { phase, afterId: last.id };
        break;
      }
      phase = "reservations";
      afterId = null;
      nextCursor = { phase, afterId };
      phasesVisited += 1;
      cycleComplete = true;
    }

    assertBatchCanContinue(input);
    await saveReconciliationCursor(tx, nextCursor);
    return {
      issues,
      processed,
      processedEntities,
      cursor: nextCursor,
      cycleComplete,
    };
  });
}

export async function reconcileCreditLedger(
  database: DatabaseClient,
  input: { readonly now?: Date } = {},
): Promise<readonly CreditReconciliationIssue[]> {
  const now = input.now ?? new Date();
  const issues: CreditReconciliationIssue[] = [];

  const reservations = await database.select().from(creditReservations);
  for (const reservation of reservations) {
    const [allocation] = await database
      .select({
        total: sql<number>`coalesce(sum(${creditReservationAllocations.quantity}), 0)::int`,
      })
      .from(creditReservationAllocations)
      .where(eq(creditReservationAllocations.reservationId, reservation.id));
    if (Number(allocation?.total ?? 0) !== reservation.quantity) {
      issues.push({
        code: "RESERVATION_ALLOCATION_MISMATCH",
        entityId: reservation.id,
        detail: `reserved=${reservation.quantity} allocated=${Number(allocation?.total ?? 0)}`,
      });
    }
    if (reservation.status === "active" && reservation.expiresAt <= now) {
      issues.push({
        code: "STALE_ACTIVE_RESERVATION",
        entityId: reservation.id,
        detail: reservation.expiresAt.toISOString(),
      });
    }
  }

  const grants = await database.select().from(creditGrants);
  for (const grant of grants) {
    const rows = await database
      .select({
        entryType: creditLedgerEntries.entryType,
        total: sql<number>`coalesce(sum(${creditLedgerEntries.quantity}), 0)::int`,
      })
      .from(creditLedgerEntries)
      .where(eq(creditLedgerEntries.grantId, grant.id))
      .groupBy(creditLedgerEntries.entryType);
    const totals = new Map(rows.map((row) => [row.entryType, Number(row.total)]));
    if ((totals.get("grant") ?? 0) !== grant.quantity) {
      issues.push({
        code: "GRANT_LEDGER_MISMATCH",
        entityId: grant.id,
        detail: `grant=${grant.quantity} ledger=${totals.get("grant") ?? 0}`,
      });
    }
    const terminal =
      (totals.get("consume") ?? 0) +
      (totals.get("expire") ?? 0) +
      (totals.get("revoke") ?? 0) +
      (totals.get("adjust_negative") ?? 0);
    if (terminal > grant.quantity) {
      issues.push({
        code: "GRANT_OVERDRAWN",
        entityId: grant.id,
        detail: `quantity=${grant.quantity} terminal=${terminal}`,
      });
    }
    if (
      grant.state === "expired" &&
      (totals.get("expire") ?? 0) === 0 &&
      terminal < grant.quantity
    ) {
      issues.push({
        code: "EXPIRED_GRANT_WITHOUT_EXPIRY_ENTRY",
        entityId: grant.id,
        detail: `remaining=${grant.quantity - terminal}`,
      });
    }
  }

  const scopes = new Map<string, { subjectId: string; creditType: string }>();
  for (const grant of grants) {
    scopes.set(`${grant.subjectId}:${grant.creditType}`, {
      subjectId: grant.subjectId,
      creditType: grant.creditType,
    });
  }
  for (const scope of scopes.values()) {
    try {
      for (const projection of await getGrantQuantityProjections(database, scope)) {
        const conserved =
          projection.consumed +
          projection.revoked +
          projection.expired +
          projection.activeReserved +
          projection.available;
        if (conserved !== projection.quantity) {
          issues.push({
            code: "GRANT_QUANTITY_INVARIANT",
            entityId: projection.grantId,
            detail: `quantity=${projection.quantity} conserved=${conserved}`,
          });
        }
      }
    } catch (error) {
      issues.push({
        code: "GRANT_QUANTITY_INVARIANT",
        entityId: `${scope.subjectId}:${scope.creditType}`,
        detail: error instanceof Error ? error.message : "projection failed",
      });
    }
  }

  const crossSubject = await database
    .select({ reservationId: creditReservations.id, grantId: creditGrants.id })
    .from(creditReservationAllocations)
    .innerJoin(
      creditReservations,
      eq(creditReservations.id, creditReservationAllocations.reservationId),
    )
    .innerJoin(creditGrants, eq(creditGrants.id, creditReservationAllocations.grantId))
    .where(sql`${creditReservations.subjectId} <> ${creditGrants.subjectId}`);
  for (const row of crossSubject) {
    issues.push({
      code: "CROSS_SUBJECT_ALLOCATION",
      entityId: row.reservationId,
      detail: row.grantId,
    });
  }

  const crossType = await database
    .select({ reservationId: creditReservations.id, grantId: creditGrants.id })
    .from(creditReservationAllocations)
    .innerJoin(
      creditReservations,
      eq(creditReservations.id, creditReservationAllocations.reservationId),
    )
    .innerJoin(creditGrants, eq(creditGrants.id, creditReservationAllocations.grantId))
    .where(sql`${creditReservations.creditType} <> ${creditGrants.creditType}`);
  for (const row of crossType) {
    issues.push({
      code: "CROSS_CREDIT_TYPE_ALLOCATION",
      entityId: row.reservationId,
      detail: row.grantId,
    });
  }

  const missingTerminalEntries = await database
    .select({ id: creditReservations.id, status: creditReservations.status })
    .from(creditReservations)
    .where(
      and(
        sql`${creditReservations.status} in ('committed','released','expired')`,
        sql`not exists (
          select 1 from ${creditLedgerEntries}
          where ${creditLedgerEntries.reservationId} = ${creditReservations.id}
            and ${creditLedgerEntries.entryType} in ('consume','release')
        )`,
      ),
    );
  for (const row of missingTerminalEntries) {
    issues.push({
      code: "TERMINAL_RESERVATION_WITHOUT_LEDGER",
      entityId: row.id,
      detail: row.status,
    });
  }

  return issues;
}
