import { and, eq, sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
  creditGrants,
  creditLedgerEntries,
  creditReservationAllocations,
  creditReservations,
} from "@/platform/database/credit-schema";

export type CreditReconciliationIssue = {
  readonly code: string;
  readonly entityId: string;
  readonly detail: string;
};

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
