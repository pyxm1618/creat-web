import { and, asc, eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
  accountDeletionRequests,
  authSecurityEvents,
  commerceCommandJobs,
  creditFinalizationJobs,
  fulfillmentJobs,
  paymentWebhookInbox,
} from "@/platform/database/schema";

export type DeadLetterQueue =
  | "webhook"
  | "fulfillment"
  | "commerce_command"
  | "credit_finalization"
  | "account_deletion";

export type DeadLetterSummary = Readonly<{
  queue: DeadLetterQueue;
  id: string;
  attempts: number;
  errorCode: string | null;
  createdAt: string;
}>;

export async function inspectDeadLetters(
  database: DatabaseClient,
  limit = 50,
): Promise<DeadLetterSummary[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const [webhook, fulfillment, commands, finalization, deletions] = await Promise.all([
    database
      .select({
        id: paymentWebhookInbox.id,
        attempts: paymentWebhookInbox.attempts,
        errorCode: paymentWebhookInbox.lastErrorCode,
        createdAt: paymentWebhookInbox.receivedAt,
      })
      .from(paymentWebhookInbox)
      .where(eq(paymentWebhookInbox.state, "dead_letter"))
      .orderBy(asc(paymentWebhookInbox.receivedAt))
      .limit(boundedLimit),
    database
      .select({
        id: fulfillmentJobs.id,
        attempts: fulfillmentJobs.attempts,
        errorCode: fulfillmentJobs.lastErrorCode,
        createdAt: fulfillmentJobs.createdAt,
      })
      .from(fulfillmentJobs)
      .where(eq(fulfillmentJobs.state, "dead_letter"))
      .orderBy(asc(fulfillmentJobs.createdAt))
      .limit(boundedLimit),
    database
      .select({
        id: commerceCommandJobs.id,
        attempts: commerceCommandJobs.attempts,
        errorCode: commerceCommandJobs.lastErrorCode,
        createdAt: commerceCommandJobs.createdAt,
      })
      .from(commerceCommandJobs)
      .where(eq(commerceCommandJobs.state, "dead_letter"))
      .orderBy(asc(commerceCommandJobs.createdAt))
      .limit(boundedLimit),
    database
      .select({
        id: creditFinalizationJobs.id,
        attempts: creditFinalizationJobs.attempts,
        errorCode: creditFinalizationJobs.lastErrorCode,
        createdAt: creditFinalizationJobs.createdAt,
      })
      .from(creditFinalizationJobs)
      .where(eq(creditFinalizationJobs.state, "dead_letter"))
      .orderBy(asc(creditFinalizationJobs.createdAt))
      .limit(boundedLimit),
    database
      .select({
        id: accountDeletionRequests.id,
        attempts: accountDeletionRequests.attempts,
        errorCode: accountDeletionRequests.lastErrorCode,
        createdAt: accountDeletionRequests.createdAt,
      })
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.status, "dead_letter"))
      .orderBy(asc(accountDeletionRequests.createdAt))
      .limit(boundedLimit),
  ]);

  const normalize = (
    queue: DeadLetterQueue,
    rows: readonly {
      id: string;
      attempts: number;
      errorCode: string | null;
      createdAt: Date;
    }[],
  ): DeadLetterSummary[] =>
    rows.map((row) => ({
      queue,
      id: row.id,
      attempts: row.attempts,
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
    }));

  return [
    ...normalize("webhook", webhook),
    ...normalize("fulfillment", fulfillment),
    ...normalize("commerce_command", commands),
    ...normalize("credit_finalization", finalization),
    ...normalize("account_deletion", deletions),
  ]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, boundedLimit);
}

export async function retryDeadLetter(
  database: DatabaseClient,
  input: Readonly<{
    queue: DeadLetterQueue;
    id: string;
    environment: "local" | "test" | "staging" | "production";
    reason: string;
    now?: Date;
  }>,
): Promise<boolean> {
  if (!input.id.trim()) throw new Error("dead-letter record id is required");
  const reason = input.reason.trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new Error("dead-letter retry reason must contain 8 to 500 characters");
  }
  const now = input.now ?? new Date();

  return database.transaction(async (tx) => {
    let changed = false;
    if (input.queue === "webhook") {
      const [row] = await tx
        .update(paymentWebhookInbox)
        .set({
          state: "retry",
          attempts: 0,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(
          and(eq(paymentWebhookInbox.id, input.id), eq(paymentWebhookInbox.state, "dead_letter")),
        )
        .returning({ id: paymentWebhookInbox.id });
      changed = Boolean(row);
    } else if (input.queue === "fulfillment") {
      const [row] = await tx
        .update(fulfillmentJobs)
        .set({
          state: "pending",
          attempts: 0,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(and(eq(fulfillmentJobs.id, input.id), eq(fulfillmentJobs.state, "dead_letter")))
        .returning({ id: fulfillmentJobs.id });
      changed = Boolean(row);
    } else if (input.queue === "commerce_command") {
      const [row] = await tx
        .update(commerceCommandJobs)
        .set({
          state: "pending",
          attempts: 0,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(
          and(eq(commerceCommandJobs.id, input.id), eq(commerceCommandJobs.state, "dead_letter")),
        )
        .returning({ id: commerceCommandJobs.id });
      changed = Boolean(row);
    } else if (input.queue === "credit_finalization") {
      const [row] = await tx
        .update(creditFinalizationJobs)
        .set({
          state: "pending",
          attempts: 0,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(creditFinalizationJobs.id, input.id),
            eq(creditFinalizationJobs.state, "dead_letter"),
          ),
        )
        .returning({ id: creditFinalizationJobs.id });
      changed = Boolean(row);
    } else {
      const [row] = await tx
        .update(accountDeletionRequests)
        .set({
          status: "failed",
          attempts: 0,
          nextAttemptAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(accountDeletionRequests.id, input.id),
            eq(accountDeletionRequests.status, "dead_letter"),
          ),
        )
        .returning({ id: accountDeletionRequests.id });
      changed = Boolean(row);
    }

    if (changed) {
      await tx.insert(authSecurityEvents).values({
        eventType: "dead_letter_retried",
        outcome: "accepted",
        details: {
          queue: input.queue,
          recordId: input.id,
          environment: input.environment,
          reason,
        },
      });
    }
    return changed;
  });
}
