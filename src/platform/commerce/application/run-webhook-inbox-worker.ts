import { eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { authSecurityEvents, paymentWebhookInbox } from "@/platform/database/schema";

import { parseNormalizedProviderEvent } from "./event-json";
import { claimWebhookInbox, retryDelay } from "./job-leases";
import { processProviderEvent } from "./process-provider-event";

const MAX_ATTEMPTS = 12;

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 120);
  return "UNKNOWN_ERROR";
}

export async function runWebhookInboxWorker(input: {
  readonly database: DatabaseClient;
  readonly owner: string;
  readonly now: Date;
  readonly limit: number;
}): Promise<{ readonly claimed: number; readonly processed: number }> {
  const inbox = await claimWebhookInbox(input.database, {
    owner: input.owner,
    now: input.now,
    limit: input.limit,
  });
  let processed = 0;

  for (const row of inbox) {
    try {
      const event = parseNormalizedProviderEvent(row.normalizedPayloadJson);
      await processProviderEvent(input.database, event, row.payloadHash);
      await input.database
        .update(paymentWebhookInbox)
        .set({
          state: "completed",
          processedAt: input.now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(eq(paymentWebhookInbox.id, row.id));
      processed += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await input.database.transaction(async (tx) => {
        await tx
          .update(paymentWebhookInbox)
          .set({
            state: dead ? "dead_letter" : "retry",
            attempts,
            nextAttemptAt: new Date(input.now.getTime() + retryDelay(attempts)),
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

  return { claimed: inbox.length, processed };
}
