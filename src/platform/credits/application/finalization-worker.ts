import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";

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
): Promise<{
  readonly claimed: number;
  readonly processed: number;
  readonly completed: number;
  readonly deferred: number;
  readonly deadLettered: number;
  readonly lostLease: number;
}> {
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
    const claimed: Array<(typeof candidates)[number] & { leaseToken: string }> = [];
    for (const candidate of candidates) {
      const leaseToken = randomUUID();
      const [job] = await tx
        .update(creditFinalizationJobs)
        .set({ state: "processing", leaseOwner: input.owner, leaseToken, leaseExpiresAt })
        .where(eq(creditFinalizationJobs.id, candidate.id))
        .returning();
      if (job) claimed.push({ ...job, leaseToken });
    }
    return claimed;
  });

  let processed = 0;
  let completed = 0;
  let deferred = 0;
  let deadLettered = 0;
  let lostLease = 0;
  for (const job of jobs) {
    try {
      await commitReservation(database, {
        reservationId: job.reservationId,
        correlationId: `delivery:${job.deliveryReference}`,
        now,
      });
      const terminalNow = new Date();
      const [owned] = await database
        .update(creditFinalizationJobs)
        .set({
          state: "completed",
          completedAt: now,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(creditFinalizationJobs.id, job.id),
            eq(creditFinalizationJobs.state, "processing"),
            eq(creditFinalizationJobs.leaseOwner, input.owner),
            eq(creditFinalizationJobs.leaseToken, job.leaseToken),
            gt(creditFinalizationJobs.leaseExpiresAt, terminalNow),
          ),
        )
        .returning({ id: creditFinalizationJobs.id });
      if (owned) completed += 1;
      else lostLease += 1;
    } catch (error) {
      const attempts = job.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const terminalNow = new Date();
      const owned = await database.transaction(async (tx) => {
        const [updated] = await tx
          .update(creditFinalizationJobs)
          .set({
            state: dead ? "dead_letter" : "pending",
            attempts,
            nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)),
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: errorCode(error),
          })
          .where(
            and(
              eq(creditFinalizationJobs.id, job.id),
              eq(creditFinalizationJobs.state, "processing"),
              eq(creditFinalizationJobs.leaseOwner, input.owner),
              eq(creditFinalizationJobs.leaseToken, job.leaseToken),
              gt(creditFinalizationJobs.leaseExpiresAt, terminalNow),
            ),
          )
          .returning({ id: creditFinalizationJobs.id });
        if (!updated) return false;
        if (dead) {
          await tx.insert(authSecurityEvents).values({
            eventType: "dead_letter_created",
            outcome: "failure",
            details: { queue: "credit_finalization" },
          });
        }
        return true;
      });
      if (!owned) lostLease += 1;
      else if (dead) deadLettered += 1;
      else deferred += 1;
    }
    processed += 1;
  }
  return {
    claimed: jobs.length,
    processed,
    completed,
    deferred,
    deadLettered,
    lostLease,
  };
}
