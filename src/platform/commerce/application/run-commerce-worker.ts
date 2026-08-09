import { eq } from "drizzle-orm";

import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import type { DatabaseClient } from "@/platform/database/client";
import {
  authSecurityEvents,
  fulfillmentJobs,
  paymentWebhookInbox,
} from "@/platform/database/schema";

import { parseNormalizedProviderEvent } from "./event-json";
import { claimFulfillmentJobs, claimWebhookInbox, retryDelay } from "./job-leases";
import type { OrderFulfillment } from "./order-fulfillment";
import { processProviderEvent } from "./process-provider-event";
import { runCommerceCommandWorker } from "./run-commerce-command-worker";

const MAX_ATTEMPTS = 12;

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 120);
  return "UNKNOWN_ERROR";
}

export async function runCommerceWorker(input: {
  readonly database: DatabaseClient;
  readonly provider: PaymentProvider;
  readonly fulfillment: OrderFulfillment;
  readonly owner: string;
  readonly now?: Date;
}): Promise<{
  readonly inboxProcessed: number;
  readonly commandProcessed: number;
  readonly fulfillmentProcessed: number;
}> {
  const now = input.now ?? new Date();
  let inboxProcessed = 0;
  let fulfillmentProcessed = 0;

  for (const row of await claimWebhookInbox(input.database, { owner: input.owner, now })) {
    try {
      const event = parseNormalizedProviderEvent(row.normalizedPayloadJson);
      await processProviderEvent(input.database, event, row.payloadHash);
      await input.database
        .update(paymentWebhookInbox)
        .set({
          state: "completed",
          processedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(eq(paymentWebhookInbox.id, row.id));
      inboxProcessed += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await input.database.transaction(async (tx) => {
        await tx
          .update(paymentWebhookInbox)
          .set({
            state: dead ? "dead_letter" : "retry",
            attempts,
            nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: errorCode(error),
          })
          .where(eq(paymentWebhookInbox.id, row.id));
        if (dead) {
          await tx.insert(authSecurityEvents).values({
            eventType: "dead_letter_created",
            outcome: "failure",
            details: { queue: "webhook" },
          });
        }
      });
    }
  }

  const commandProcessed = await runCommerceCommandWorker({
    database: input.database,
    provider: input.provider,
    owner: input.owner,
    now,
  });

  for (const job of await claimFulfillmentJobs(input.database, { owner: input.owner, now })) {
    try {
      await input.fulfillment.fulfill({
        sourceType: job.sourceType,
        sourceId: job.sourceId,
        operation: job.operation,
        operationKey: job.idempotencyKey,
      });
      await input.database
        .update(fulfillmentJobs)
        .set({
          state: "completed",
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(eq(fulfillmentJobs.id, job.id));
      fulfillmentProcessed += 1;
    } catch (error) {
      const attempts = job.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await input.database.transaction(async (tx) => {
        await tx
          .update(fulfillmentJobs)
          .set({
            state: dead ? "dead_letter" : "pending",
            attempts,
            nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: errorCode(error),
          })
          .where(eq(fulfillmentJobs.id, job.id));
        if (dead) {
          await tx.insert(authSecurityEvents).values({
            eventType: "dead_letter_created",
            outcome: "failure",
            details: { queue: "fulfillment" },
          });
        }
      });
    }
  }

  return { inboxProcessed, commandProcessed, fulfillmentProcessed };
}
