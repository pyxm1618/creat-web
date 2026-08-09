import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { authSecurityEvents, creditFinalizationJobs } from "@/platform/database/schema";

import { commitReservation } from "./credit-service";

const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 12;

function retryDelay(attempt: number): number {
  return Math.min(60 * 60 * 1000, 2 ** Math.min(attempt, 10) * 1000);
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 120) : "UNKNOWN_ERROR";
}

export async function runCreditFinalizationWorker(
  database: DatabaseClient,
  input: { readonly owner: string; readonly now?: Date; readonly limit?: number },
): Promise<{ readonly completed: number; readonly deferred: number }> {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const jobs = await database.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(creditFinalizationJobs)
      .where(
        and(
          inArray(creditFinalizationJobs.state, ["pending", "processing"]),
          lte(creditFinalizationJobs.nextAttemptAt, now),
          or(
            isNull(creditFinalizationJobs.leaseOwner),
            isNull(creditFinalizationJobs.leaseExpiresAt),
            lte(creditFinalizationJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(creditFinalizationJobs.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed = [];
    for (const candidate of candidates) {
      const [job] = await tx
        .update(creditFinalizationJobs)
        .set({ state: "processing", leaseOwner: input.owner, leaseExpiresAt })
        .where(eq(creditFinalizationJobs.id, candidate.id))
        .returning();
      if (job) claimed.push(job);
    }
    return claimed;
  });

  let completed = 0;
  let deferred = 0;
  for (const job of jobs) {
    try {
      await commitReservation(database, {
        reservationId: job.reservationId,
        correlationId: `delivery:${job.deliveryReference}`,
        now,
      });
      await database
        .update(creditFinalizationJobs)
        .set({
          state: "completed",
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(creditFinalizationJobs.id, job.id),
            eq(creditFinalizationJobs.leaseOwner, input.owner),
          ),
        );
      completed += 1;
    } catch (error) {
      const attempts = job.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await database.transaction(async (tx) => {
        await tx
          .update(creditFinalizationJobs)
          .set({
            state: dead ? "dead_letter" : "pending",
            attempts,
            nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: errorCode(error),
          })
          .where(
            and(
              eq(creditFinalizationJobs.id, job.id),
              eq(creditFinalizationJobs.leaseOwner, input.owner),
            ),
          );
        if (dead) {
          await tx.insert(authSecurityEvents).values({
            eventType: "dead_letter_created",
            outcome: "failure",
            details: { queue: "credit_finalization" },
          });
        }
      });
      deferred += 1;
    }
  }
  return { completed, deferred };
}
