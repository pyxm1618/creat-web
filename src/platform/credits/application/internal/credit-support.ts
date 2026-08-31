import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { accountSubjects } from "@/platform/database/account-subject-schema";
import {
  creditGrants,
  creditLedgerEntries,
  creditReservationAllocations,
  creditReservations,
} from "@/platform/database/credit-schema";

import type { CreditAllocation, CreditReservationStatus } from "../../domain/types";

export type CreditTx = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

type GrantReduction = { consumed: number; expired: number; revoked: number };

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

export type CreditGrantQuantityProjection = {
  readonly grantId: string;
  readonly quantity: number;
  readonly consumed: number;
  readonly revoked: number;
  readonly expired: number;
  readonly activeReserved: number;
  readonly available: number;
};

export async function ensureActiveSubject(tx: CreditTx, subjectId: string): Promise<void> {
  const subject = await tx.query.accountSubjects.findFirst({
    where: and(eq(accountSubjects.id, subjectId), eq(accountSubjects.status, "active")),
  });
  if (!subject) throw new Error("active account subject is required");
}

export async function loadAllocations(
  tx: CreditTx,
  reservationId: string,
): Promise<CreditAllocation[]> {
  return tx
    .select({
      grantId: creditReservationAllocations.grantId,
      quantity: creditReservationAllocations.quantity,
    })
    .from(creditReservationAllocations)
    .where(eq(creditReservationAllocations.reservationId, reservationId))
    .orderBy(asc(creditReservationAllocations.grantId));
}

export async function loadGrantReductions(
  tx: CreditTx,
  grantIds: readonly string[],
): Promise<Map<string, GrantReduction>> {
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

  const result = new Map<string, GrantReduction>();
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

export async function loadActiveReserved(
  tx: CreditTx,
  grantIds: readonly string[],
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
      ),
    )
    .groupBy(creditReservationAllocations.grantId);
  return new Map(rows.map((row) => [row.grantId, Number(row.total)]));
}

export function projectionForGrant(
  grant: { id: string; quantity: number },
  reduction: GrantReduction,
  activeReserved: number,
): CreditGrantQuantityProjection {
  const available =
    grant.quantity - reduction.consumed - reduction.expired - reduction.revoked - activeReserved;
  if (available < 0) throw new Error(`credit quantity invariant failed for grant ${grant.id}`);
  return {
    grantId: grant.id,
    quantity: grant.quantity,
    consumed: reduction.consumed,
    revoked: reduction.revoked,
    expired: reduction.expired,
    activeReserved,
    available,
  };
}

export async function loadGrantQuantityProjections(
  tx: CreditTx,
  grantIds: readonly string[],
): Promise<CreditGrantQuantityProjection[]> {
  if (grantIds.length === 0) return [];
  const grants = await tx
    .select({ id: creditGrants.id, quantity: creditGrants.quantity })
    .from(creditGrants)
    .where(inArray(creditGrants.id, [...grantIds]))
    .orderBy(asc(creditGrants.id));
  const reductions = await loadGrantReductions(tx, grantIds);
  const reserved = await loadActiveReserved(tx, grantIds);
  return grants.map((grant) =>
    projectionForGrant(
      grant,
      reductions.get(grant.id) ?? { consumed: 0, expired: 0, revoked: 0 },
      reserved.get(grant.id) ?? 0,
    ),
  );
}

export async function assertGrantQuantityInvariant(
  tx: CreditTx,
  grantIds: readonly string[],
): Promise<void> {
  for (const projection of await loadGrantQuantityProjections(tx, grantIds)) {
    const total =
      projection.consumed +
      projection.revoked +
      projection.expired +
      projection.activeReserved +
      projection.available;
    if (total !== projection.quantity) {
      throw new Error(`credit quantity invariant failed for grant ${projection.grantId}`);
    }
  }
}

export async function maybeMarkExpiredGrantTerminal(
  tx: CreditTx,
  grantId: string,
  now: Date,
): Promise<void> {
  const grant = await tx.query.creditGrants.findFirst({ where: eq(creditGrants.id, grantId) });
  if (!grant || !grant.expiresAt || grant.expiresAt > now || grant.state === "revoked") return;
  const [projection] = await loadGrantQuantityProjections(tx, [grant.id]);
  if (!projection) return;
  if (projection.activeReserved === 0 && projection.available === 0) {
    await tx.update(creditGrants).set({ state: "expired" }).where(eq(creditGrants.id, grant.id));
  }
}

export async function reservationRecord(
  tx: CreditTx,
  id: string,
): Promise<CreditReservationRecord> {
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
