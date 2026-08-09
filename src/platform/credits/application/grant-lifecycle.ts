import { and, asc, eq, lte, sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { creditGrants, creditLedgerEntries } from "@/platform/database/credit-schema";

import { assertCreditQuantity } from "../domain/invariants";
import type { CreditSource } from "../domain/types";
import { tryCreditMutationLock, withCreditMutationLock } from "../infrastructure/credit-lock";
import {
  assertGrantQuantityInvariant,
  loadActiveReserved,
  loadGrantReductions,
  maybeMarkExpiredGrantTerminal,
} from "./internal/credit-support";

export async function expireGrants(
  database: DatabaseClient,
  input: { readonly now?: Date; readonly limit?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const candidates = await database
    .select({
      id: creditGrants.id,
      subjectId: creditGrants.subjectId,
      creditType: creditGrants.creditType,
    })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.state, "active"),
        sql`${creditGrants.expiresAt} is not null`,
        lte(creditGrants.expiresAt, now),
      ),
    )
    .orderBy(asc(creditGrants.id))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));

  let count = 0;
  for (const candidate of candidates) {
    await database.transaction(async (tx) => {
      const locked = await tryCreditMutationLock({
        tx,
        subjectId: candidate.subjectId,
        creditType: candidate.creditType,
      });
      if (!locked) return;

      const [grant] = await tx
        .select()
        .from(creditGrants)
        .where(eq(creditGrants.id, candidate.id))
        .limit(1)
        .for("update");
      if (!grant || grant.state !== "active" || !grant.expiresAt || grant.expiresAt > now) return;

      const reductions = await loadGrantReductions(tx, [grant.id]);
      const activeReserved = await loadActiveReserved(tx, [grant.id]);
      const reduction = reductions.get(grant.id) ?? { consumed: 0, expired: 0, revoked: 0 };
      const reserved = activeReserved.get(grant.id) ?? 0;
      const expirableNow = Math.max(
        0,
        grant.quantity - reduction.consumed - reduction.expired - reduction.revoked - reserved,
      );

      if (expirableNow > 0) {
        await tx
          .insert(creditLedgerEntries)
          .values({
            subjectId: grant.subjectId,
            creditType: grant.creditType,
            grantId: grant.id,
            entryType: "expire",
            quantity: expirableNow,
            sourceType: grant.sourceType,
            sourceId: grant.sourceId,
            correlationId: `grant-expiry:${grant.id}`,
            idempotencyKey: `expire:${grant.id}:available-at-source-expiry`,
            actorType: "system",
          })
          .onConflictDoNothing({ target: creditLedgerEntries.idempotencyKey });
      }

      await assertGrantQuantityInvariant(tx, [grant.id]);
      await maybeMarkExpiredGrantTerminal(tx, grant.id, now);
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
    if (!input.partialPolicy) {
      throw new Error("partial credit reversal requires operator-reviewed policy");
    }
  }
  const now = input.now ?? new Date();
  const grants = await database
    .select({
      id: creditGrants.id,
      subjectId: creditGrants.subjectId,
      creditType: creditGrants.creditType,
    })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.sourceType, input.source.type),
        eq(creditGrants.sourceId, input.source.id),
      ),
    )
    .orderBy(asc(creditGrants.id));
  if (grants.length === 0) return { revoked: 0, blocked: input.quantity ?? 0 };

  let targetRemaining = input.quantity ?? Number.MAX_SAFE_INTEGER;
  let revoked = 0;
  let blocked = 0;
  for (const candidate of grants) {
    if (targetRemaining <= 0) break;
    await database.transaction((tx) =>
      withCreditMutationLock({
        tx,
        subjectId: candidate.subjectId,
        creditType: candidate.creditType,
        run: async () => {
          const [grant] = await tx
            .select()
            .from(creditGrants)
            .where(eq(creditGrants.id, candidate.id))
            .limit(1)
            .for("update");
          if (!grant) return;
          const reductions = await loadGrantReductions(tx, [grant.id]);
          const activeReserved = await loadActiveReserved(tx, [grant.id]);
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
          await assertGrantQuantityInvariant(tx, [grant.id]);
          await maybeMarkExpiredGrantTerminal(tx, grant.id, now);
        },
      }),
    );
  }
  if (input.quantity !== undefined && revoked < input.quantity) blocked = input.quantity - revoked;
  return { revoked, blocked };
}
