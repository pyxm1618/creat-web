import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { paymentWebhookInbox } from "@/platform/database/commerce-schema";

export async function purgeExpiredWebhookPayloads(
  database: DatabaseClient,
  input: { readonly now?: Date; readonly limit?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);

  return database.transaction(async (tx) => {
    const rows = await tx
      .select({ id: paymentWebhookInbox.id })
      .from(paymentWebhookInbox)
      .where(
        and(
          isNotNull(paymentWebhookInbox.rawPayloadCiphertext),
          isNotNull(paymentWebhookInbox.rawPayloadExpiresAt),
          lte(paymentWebhookInbox.rawPayloadExpiresAt, now),
          or(
            isNull(paymentWebhookInbox.legalHoldReviewAt),
            lte(paymentWebhookInbox.legalHoldReviewAt, now),
          ),
        ),
      )
      .limit(limit)
      .for("update", { skipLocked: true });

    for (const row of rows) {
      await tx
        .update(paymentWebhookInbox)
        .set({
          rawPayloadCiphertext: null,
          rawPayloadKeyId: null,
          rawPayloadExpiresAt: null,
          rawPayloadPurgedAt: now,
        })
        .where(
          and(
            eq(paymentWebhookInbox.id, row.id),
            isNotNull(paymentWebhookInbox.rawPayloadCiphertext),
          ),
        );
    }

    return rows.length;
  });
}

export async function purgeRejectedWebhookDiagnostics(
  database: DatabaseClient,
  input: { readonly now?: Date; readonly limit?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);

  return database.transaction(async (tx) => {
    const rows = await tx
      .select({ id: paymentWebhookInbox.id })
      .from(paymentWebhookInbox)
      .where(
        and(
          eq(paymentWebhookInbox.signatureValid, false),
          eq(paymentWebhookInbox.state, "rejected"),
          lte(paymentWebhookInbox.receivedAt, cutoff),
        ),
      )
      .orderBy(paymentWebhookInbox.receivedAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return 0;

    const deleted = await tx
      .delete(paymentWebhookInbox)
      .where(
        and(
          inArray(
            paymentWebhookInbox.id,
            rows.map((row) => row.id),
          ),
          eq(paymentWebhookInbox.signatureValid, false),
          eq(paymentWebhookInbox.state, "rejected"),
          lte(paymentWebhookInbox.receivedAt, cutoff),
        ),
      )
      .returning({ id: paymentWebhookInbox.id });
    return deleted.length;
  });
}
