import { eq } from "drizzle-orm";

import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import type { DatabaseClient } from "@/platform/database/client";
import {
  authSecurityEvents,
  commerceCommandJobs,
  commerceReconciliationRuns,
  refunds,
} from "@/platform/database/schema";

import { executeCommerceCommand } from "./execute-commerce-command";
import { claimCommerceCommandJobs, retryDelay } from "./job-leases";

const MAX_ATTEMPTS = 12;

function errorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name.slice(0, 120) : "UNKNOWN_ERROR";
}

export async function runCommerceCommandWorker(input: {
  readonly database: DatabaseClient;
  readonly provider: PaymentProvider;
  readonly owner: string;
  readonly now?: Date;
  readonly limit?: number;
  readonly onClaimed?: (count: number) => void;
}): Promise<number> {
  const now = input.now ?? new Date();
  let processed = 0;
  const jobs = await claimCommerceCommandJobs(input.database, {
    owner: input.owner,
    now,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  input.onClaimed?.(jobs.length);

  for (const job of jobs) {
    try {
      await executeCommerceCommand({
        database: input.database,
        provider: input.provider,
        job,
        now,
      });

      await input.database
        .update(commerceCommandJobs)
        .set({
          state: "completed",
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        })
        .where(eq(commerceCommandJobs.id, job.id));
      processed += 1;
    } catch (error) {
      const attempts = job.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await input.database.transaction(async (tx) => {
        await tx
          .update(commerceCommandJobs)
          .set({
            state: dead ? "dead_letter" : "pending",
            attempts,
            nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: errorCode(error),
          })
          .where(eq(commerceCommandJobs.id, job.id));
        await tx.insert(authSecurityEvents).values({
          eventType: "provider_failure",
          outcome: "failure",
          details: { provider: "waffo", queue: "commerce_command", command: job.commandType },
        });
        if (dead) {
          await tx.insert(authSecurityEvents).values({
            eventType: "dead_letter_created",
            outcome: "failure",
            details: { queue: "commerce_command" },
          });
        }
        if (dead && job.commandType === "refund_request") {
          const [refund] = await tx
            .update(refunds)
            .set({
              status: "reconciliation_required",
              reversalStatus: "reconciliation_required",
              operatorReviewReason: "refund provider command exhausted retries",
              updatedAt: now,
            })
            .where(eq(refunds.id, job.targetId))
            .returning({ id: refunds.id, paymentId: refunds.paymentId });
          if (refund) {
            await tx.insert(commerceReconciliationRuns).values({
              targetType: "payment_refund",
              targetId: refund.paymentId,
              actorType: "worker",
              beforeJson: {
                refundId: refund.id,
                commandId: job.id,
                attempts,
              },
              afterJson: {
                refundId: refund.id,
                status: "reconciliation_required",
                reason: "provider_command_dead_letter",
              },
              result: "operator_review_required",
            });
          }
        }
      });
    }
  }
  return processed;
}
