import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { fulfillmentJobs } from "@/platform/database/commerce-schema";

import type { OrderFulfillment } from "./order-fulfillment";
import { retryDelay } from "./job-leases";

const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 12;

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 120);
  return "UNKNOWN_ERROR";
}

export async function attemptFulfillmentForSource(input: {
  readonly database: DatabaseClient;
  readonly fulfillment: OrderFulfillment;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly owner: string;
  readonly now?: Date;
}): Promise<"completed" | "deferred" | "missing"> {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);

  const job = await input.database.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(fulfillmentJobs)
      .where(
        and(
          eq(fulfillmentJobs.sourceType, input.sourceType),
          eq(fulfillmentJobs.sourceId, input.sourceId),
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
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;

    const [claimed] = await tx
      .update(fulfillmentJobs)
      .set({ state: "processing", leaseOwner: input.owner, leaseExpiresAt })
      .where(eq(fulfillmentJobs.id, candidate.id))
      .returning();
    return claimed ?? null;
  });

  if (!job) {
    const existing = await input.database.query.fulfillmentJobs.findFirst({
      where: and(
        eq(fulfillmentJobs.sourceType, input.sourceType),
        eq(fulfillmentJobs.sourceId, input.sourceId),
      ),
    });
    if (!existing) return "missing";
    return existing.state === "completed" ? "completed" : "deferred";
  }

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
      .where(and(eq(fulfillmentJobs.id, job.id), eq(fulfillmentJobs.leaseOwner, input.owner)));
    return "completed";
  } catch (error) {
    const attempts = job.attempts + 1;
    await input.database
      .update(fulfillmentJobs)
      .set({
        state: attempts >= MAX_ATTEMPTS ? "dead_letter" : "pending",
        attempts,
        nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: errorCode(error),
      })
      .where(and(eq(fulfillmentJobs.id, job.id), eq(fulfillmentJobs.leaseOwner, input.owner)));
    return "deferred";
  }
}
