import { and, eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { creditGrants, creditLedgerEntries } from "@/platform/database/credit-schema";

import { assertCreditQuantity } from "../domain/invariants";
import type { CreditSource } from "../domain/types";
import { withCreditMutationLock } from "../infrastructure/credit-lock";
import { assertGrantQuantityInvariant, ensureActiveSubject } from "./internal/credit-support";

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

  return database.transaction((tx) =>
    withCreditMutationLock({
      tx,
      subjectId: input.subjectId,
      creditType: input.creditType,
      run: async () => {
        await ensureActiveSubject(tx, input.subjectId);

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
        await assertGrantQuantityInvariant(tx, [grant.id]);
        return grant;
      },
    }),
  );
}
