import { and, eq, gt } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { authSecurityEvents, fulfillmentJobs } from "@/platform/database/schema";

import { claimFulfillmentJobs, retryDelay } from "./job-leases";
import type { OrderFulfillment } from "./order-fulfillment";

const MAX_ATTEMPTS = 12;

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 120);
  return "UNKNOWN_ERROR";
}

export async function runFulfillmentWorker(input: {
  readonly database: DatabaseClient;
  readonly fulfillment: OrderFulfillment;
  readonly owner: string;
  readonly now: Date;
  readonly limit: number;
}): Promise<{ readonly claimed: number; readonly processed: number }> {
  const jobs = await claimFulfillmentJobs(input.database, {
    owner: input.owner,
    now: input.now,
    limit: input.limit,
  });
  let processed = 0;

  for (const job of jobs) {
    try {
      await input.fulfillment.fulfill({
        sourceType: job.sourceType,
        sourceId: job.sourceId,
        operation: job.operation,
        operationKey: job.idempotencyKey,
      });
      const [owned] = await input.database
        .update(fulfillmentJobs)
        .set({
          state: "completed",
          completedAt: input.now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(fulfillmentJobs.id, job.id),
            eq(fulfillmentJobs.state, "processing"),
            eq(fulfillmentJobs.leaseOwner, input.owner),
            gt(fulfillmentJobs.leaseExpiresAt, input.now),
          ),
        )
        .returning({ id: fulfillmentJobs.id });
      if (owned) processed += 1;
    } catch (error) {
      const attempts = job.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await input.database.transaction(async (tx) => {
        const [owned] = await tx
          .update(fulfillmentJobs)
          .set({
            state: dead ? "dead_letter" : "pending",
            attempts,
            nextAttemptAt: new Date(input.now.getTime() + retryDelay(attempts)),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: errorCode(error),
          })
          .where(
            and(
              eq(fulfillmentJobs.id, job.id),
              eq(fulfillmentJobs.state, "processing"),
              eq(fulfillmentJobs.leaseOwner, input.owner),
              gt(fulfillmentJobs.leaseExpiresAt, input.now),
            ),
          )
          .returning({ id: fulfillmentJobs.id });
        if (!owned) return;
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

  return { claimed: jobs.length, processed };
}
