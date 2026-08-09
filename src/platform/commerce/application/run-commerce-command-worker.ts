import { eq } from "drizzle-orm";

import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import type { DatabaseClient } from "@/platform/database/client";
import { commerceReconciliationRuns, payments } from "@/platform/database/commerce-schema";
import {
  commerceCommandJobs,
  refunds,
  subscriptions,
} from "@/platform/database/subscription-schema";
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
}): Promise<number> {
  const now = input.now ?? new Date();
  let processed = 0;
  for (const job of await claimCommerceCommandJobs(input.database, { owner: input.owner, now })) {
    try {
      if (job.commandType === "subscription_cancel" || job.commandType === "subscription_resume") {
        const subscription = await input.database.query.subscriptions.findFirst({
          where: eq(subscriptions.id, job.targetId),
        });
        if (!subscription || subscription.subjectId !== job.subjectId)
          throw new Error("subscription command target not found");
        const commandInput = {
          environment:
            subscription.environment === "production" ? ("production" as const) : ("test" as const),
          buyerIdentity: job.subjectId,
          externalOrderId: subscription.externalOrderId,
        };
        if (job.commandType === "subscription_cancel")
          await input.provider.cancelSubscription(commandInput);
        else await input.provider.resumeSubscription(commandInput);
      } else if (job.commandType === "refund_request") {
        const rows = await input.database
          .select({ refund: refunds, externalPaymentId: payments.externalPaymentId })
          .from(refunds)
          .innerJoin(payments, eq(payments.id, refunds.paymentId))
          .where(eq(refunds.id, job.targetId))
          .limit(1);
        const row = rows[0];
        if (!row || row.refund.subjectId !== job.subjectId)
          throw new Error("refund command target not found");
        if (row.refund.status === "succeeded" || row.refund.status === "failed") {
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
          continue;
        }
        const result = await input.provider.requestRefund({
          environment: row.refund.environment === "production" ? "production" : "test",
          buyerIdentity: job.subjectId,
          externalPaymentId: row.externalPaymentId,
          amount: {
            currency: row.refund.currency as
              | "USD"
              | "EUR"
              | "GBP"
              | "SGD"
              | "AUD"
              | "CAD"
              | "JPY"
              | "KRW",
            minor: row.refund.requestedMinor,
          },
          reason: row.refund.reason,
          idempotencyKey: row.refund.idempotencyKey,
        });
        await input.database
          .update(refunds)
          .set({
            externalRefundReference: result.externalRefundReference,
            status:
              result.status === "failed"
                ? "failed"
                : result.status === "succeeded"
                  ? "processing"
                  : result.status,
            providerUpdatedAt: now,
            updatedAt: now,
          })
          .where(eq(refunds.id, row.refund.id));
      } else {
        throw new Error(`unsupported commerce command: ${job.commandType}`);
      }

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
