import { and, asc, eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { creditGrants } from "@/platform/database/credit-schema";

import type { CreditBalance } from "../domain/types";
import {
  loadActiveReserved,
  loadGrantQuantityProjections,
  loadGrantReductions,
  projectionForGrant,
  type CreditGrantQuantityProjection,
} from "./internal/credit-support";

export type { CreditGrantQuantityProjection } from "./internal/credit-support";

export async function getGrantQuantityProjections(
  database: DatabaseClient,
  input: { readonly subjectId: string; readonly creditType: string },
): Promise<CreditGrantQuantityProjection[]> {
  return database.transaction(async (tx) => {
    const grants = await tx
      .select({ id: creditGrants.id })
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.subjectId, input.subjectId),
          eq(creditGrants.creditType, input.creditType),
        ),
      )
      .orderBy(asc(creditGrants.id));
    return loadGrantQuantityProjections(
      tx,
      grants.map((grant) => grant.id),
    );
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
    const reserved = await loadActiveReserved(tx, ids);

    let available = 0;
    let reservedTotal = 0;
    let consumed = 0;
    let expired = 0;
    let revoked = 0;

    for (const grant of grants) {
      const reduction = reductions.get(grant.id) ?? { consumed: 0, expired: 0, revoked: 0 };
      const activeReserved = reserved.get(grant.id) ?? 0;
      const projection = projectionForGrant(grant, reduction, activeReserved);
      const timeExpired = Boolean(grant.expiresAt && grant.expiresAt <= now);
      consumed += projection.consumed;
      revoked += projection.revoked;
      reservedTotal += projection.activeReserved;
      expired += projection.expired + (timeExpired ? projection.available : 0);
      if (!timeExpired) available += projection.available;
    }
    return { available, reserved: reservedTotal, consumed, expired, revoked };
  });
}
