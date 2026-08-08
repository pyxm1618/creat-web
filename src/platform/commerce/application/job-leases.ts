import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { fulfillmentJobs, paymentWebhookInbox } from "@/platform/database/commerce-schema";

const LEASE_MS = 5 * 60 * 1000;

export async function claimWebhookInbox(
  database: DatabaseClient,
  input: { readonly owner: string; readonly limit?: number; readonly now?: Date },
) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  return database.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(paymentWebhookInbox)
      .where(
        and(
          inArray(paymentWebhookInbox.state, ["pending", "retry", "processing"]),
          lte(paymentWebhookInbox.nextAttemptAt, now),
          or(
            isNull(paymentWebhookInbox.leaseOwner),
            isNull(paymentWebhookInbox.leaseExpiresAt),
            lte(paymentWebhookInbox.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(paymentWebhookInbox.receivedAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    const claimed = [];
    for (const row of candidates) {
      const [updated] = await tx
        .update(paymentWebhookInbox)
        .set({ leaseOwner: input.owner, leaseExpiresAt: expiresAt, state: "processing" })
        .where(eq(paymentWebhookInbox.id, row.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function claimFulfillmentJobs(
  database: DatabaseClient,
  input: { readonly owner: string; readonly limit?: number; readonly now?: Date },
) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  return database.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(fulfillmentJobs)
      .where(
        and(
          inArray(fulfillmentJobs.state, ["pending", "processing"]),
          lte(fulfillmentJobs.nextAttemptAt, now),
          or(
            isNull(fulfillmentJobs.leaseOwner),
            isNull(fulfillmentJobs.leaseExpiresAt),
            lte(fulfillmentJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(fulfillmentJobs.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    const claimed = [];
    for (const row of candidates) {
      const [updated] = await tx
        .update(fulfillmentJobs)
        .set({ leaseOwner: input.owner, leaseExpiresAt: expiresAt, state: "processing" })
        .where(eq(fulfillmentJobs.id, row.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export function retryDelay(attempt: number): number {
  return Math.min(60 * 60 * 1000, 2 ** Math.min(attempt, 10) * 1000);
}
