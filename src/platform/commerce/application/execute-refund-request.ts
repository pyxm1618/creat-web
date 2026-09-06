import { and, eq, inArray } from "drizzle-orm";

import { ProviderWriteOutcomeUnknownError } from "./errors";
import type { CommerceCommandJob } from "./execute-commerce-command";
import type { PaymentProvider } from "./payment-provider";
import {
  applyRefundSettlementResultInTransaction,
  type RefundSettlementCandidate,
} from "./reconcile-refund-settlements";
import type { DatabaseClient } from "@/platform/database/client";
import { commerceReconciliationRuns, orders, payments, refunds } from "@/platform/database/schema";

const REFUND_RECONCILIATION_DELAY_MS = 5 * 60 * 1000;

type RefundCurrency = "USD" | "EUR" | "GBP" | "SGD" | "AUD" | "CAD" | "JPY" | "KRW";

function refundEnvironment(value: string): "production" | "test" {
  return value === "production" ? "production" : "test";
}

function reconciliationAt(now: Date): Date {
  return new Date(now.getTime() + REFUND_RECONCILIATION_DELAY_MS);
}

function refundAmount(refund: typeof refunds.$inferSelect) {
  return {
    currency: refund.currency as RefundCurrency,
    minor: refund.requestedMinor,
  };
}

function isRefundWriteEligible(refund: typeof refunds.$inferSelect): boolean {
  return (
    refund.status === "pending" ||
    refund.status === "processing" ||
    (refund.status === "reconciliation_required" && refund.providerWriteState === "not_started")
  );
}

function isRefundReadEligible(refund: typeof refunds.$inferSelect): boolean {
  return (
    refund.status === "pending" ||
    refund.status === "processing" ||
    refund.status === "reconciliation_required"
  );
}

async function markUnknownProviderWrite(
  database: DatabaseClient,
  refundId: string,
  now: Date,
): Promise<void> {
  await database.transaction(async (tx) => {
    const [updated] = await tx
      .update(refunds)
      .set({
        providerWriteState: "ambiguous",
        status: "reconciliation_required",
        reversalStatus: "reconciliation_required",
        operatorReviewReason: "refund provider write outcome unknown; read reconciliation required",
        nextProviderReconciliationAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(refunds.id, refundId),
          eq(refunds.providerWriteState, "dispatched"),
          inArray(refunds.status, ["pending", "processing"]),
        ),
      )
      .returning({ id: refunds.id, paymentId: refunds.paymentId });
    if (!updated) return;
    await tx.insert(commerceReconciliationRuns).values({
      targetType: "payment_refund",
      targetId: updated.id,
      actorType: "worker",
      beforeJson: { refundId: updated.id, providerWriteState: "dispatched" },
      afterJson: {
        refundId: updated.id,
        providerWriteState: "ambiguous",
        status: "reconciliation_required",
        source: "provider_write_outcome_unknown",
      },
      result: "operator_review_required",
    });
  });
}

async function persistRefundRequestResult(
  database: DatabaseClient,
  input: {
    readonly refundId: string;
    readonly result: Awaited<ReturnType<PaymentProvider["requestRefund"]>>;
    readonly now: Date;
  },
): Promise<void> {
  const failed = input.result.status === "failed";
  await database
    .update(refunds)
    .set({
      externalRefundReference: input.result.externalRefundReference,
      providerWriteState: "confirmed",
      status: failed
        ? "failed"
        : input.result.status === "succeeded"
          ? "processing"
          : input.result.status,
      ...(failed
        ? {
            reversalStatus: "not_required" as const,
            operatorReviewReason: null,
            nextProviderReconciliationAt: null,
          }
        : {
            nextProviderReconciliationAt:
              input.result.status === "succeeded" ? input.now : reconciliationAt(input.now),
          }),
      providerUpdatedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(refunds.id, input.refundId),
        eq(refunds.providerWriteState, "dispatched"),
        inArray(refunds.status, ["pending", "processing"]),
      ),
    );
}

function candidateFromRow(row: {
  readonly refund: typeof refunds.$inferSelect;
  readonly externalPaymentId: string;
  readonly paymentAmount: { readonly currency: string; readonly minor: bigint };
  readonly paymentRefundStatus: string;
  readonly paymentRefundedMinor: bigint;
  readonly orderId: string;
  readonly orderStatus: string;
  readonly externalOrderId: string | null;
}): RefundSettlementCandidate {
  return {
    ...row,
    paymentAmount: {
      currency: row.paymentAmount.currency as RefundCurrency,
      minor: row.paymentAmount.minor,
    },
    sourceState: {
      refundStatus: row.refund.status,
      providerWriteState: row.refund.providerWriteState,
      reversalStatus: row.refund.reversalStatus,
      succeededMinor: row.refund.succeededMinor,
      externalRefundReference: row.refund.externalRefundReference,
      nextProviderReconciliationAt: row.refund.nextProviderReconciliationAt,
      reconciliationLeaseOwner: row.refund.reconciliationLeaseOwner,
      reconciliationLeaseExpiresAt: row.refund.reconciliationLeaseExpiresAt,
      paymentRefundStatus: row.paymentRefundStatus,
      paymentRefundedMinor: row.paymentRefundedMinor,
      orderStatus: row.orderStatus,
    },
  };
}

export async function executeRefundRequest(input: {
  readonly database: DatabaseClient;
  readonly provider: PaymentProvider;
  readonly job: CommerceCommandJob;
  readonly now: Date;
}): Promise<void> {
  const rows = await input.database
    .select({
      refund: refunds,
      externalPaymentId: payments.externalPaymentId,
      paymentAmount: {
        currency: payments.currency,
        minor: payments.amountMinor,
      },
      paymentRefundStatus: payments.refundStatus,
      paymentRefundedMinor: payments.refundedMinor,
      orderId: orders.id,
      orderStatus: orders.status,
      externalOrderId: orders.externalOrderId,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(refunds.id, input.job.targetId))
    .limit(1);
  let row = rows[0];
  if (!row || row.refund.subjectId !== input.job.subjectId)
    throw new Error("refund command target not found");
  if (row.refund.providerWriteState === "legacy_unsafe") return;
  if (!isRefundReadEligible(row.refund)) return;

  if (row.refund.providerWriteState === "not_started") {
    if (!isRefundWriteEligible(row.refund)) return;
    const [dispatched] = await input.database
      .update(refunds)
      .set({
        providerWriteState: "dispatched",
        status: "processing",
        operatorReviewReason: null,
        nextProviderReconciliationAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(refunds.id, row.refund.id),
          eq(refunds.providerWriteState, "not_started"),
          inArray(refunds.status, ["pending", "processing", "reconciliation_required"]),
        ),
      )
      .returning();
    if (dispatched) {
      row = { ...row, refund: dispatched };
      try {
        const result = await input.provider.requestRefund({
          environment: refundEnvironment(row.refund.environment),
          buyerIdentity: input.job.subjectId,
          externalPaymentId: row.externalPaymentId,
          amount: refundAmount(row.refund),
          reason: row.refund.reason,
          idempotencyKey: row.refund.idempotencyKey,
          refundIntentReference: row.refund.id,
        });
        await persistRefundRequestResult(input.database, {
          refundId: row.refund.id,
          result,
          now: input.now,
        });
        return;
      } catch (error) {
        await markUnknownProviderWrite(input.database, row.refund.id, input.now);
        throw new ProviderWriteOutcomeUnknownError(
          error instanceof Error
            ? `refund provider write outcome unknown: ${error.message}`
            : "refund provider write outcome unknown",
        );
      }
    }
    const latest = await input.database.query.refunds.findFirst({
      where: eq(refunds.id, row.refund.id),
    });
    if (!latest) throw new Error("refund command target disappeared");
    row = { ...row, refund: latest };
    if (latest.providerWriteState === "legacy_unsafe") return;
    if (!isRefundReadEligible(latest)) return;
  }

  if (
    row.refund.providerWriteState !== "dispatched" &&
    row.refund.providerWriteState !== "ambiguous" &&
    row.refund.providerWriteState !== "confirmed"
  ) {
    return;
  }

  const result = await input.provider.getRefundSettlement({
    environment: refundEnvironment(row.refund.environment),
    externalPaymentId: row.externalPaymentId,
    ...(row.externalOrderId ? { externalOrderId: row.externalOrderId } : {}),
    merchantOrderReference: row.orderId,
    paymentAmount: {
      currency: row.paymentAmount.currency as RefundCurrency,
      minor: row.paymentAmount.minor,
    },
    amount: refundAmount(row.refund),
    refundIntentReference: row.refund.id,
    ...(row.refund.externalRefundReference
      ? { externalRefundReference: row.refund.externalRefundReference }
      : {}),
  });
  await input.database.transaction(async (tx) => {
    await applyRefundSettlementResultInTransaction(tx, candidateFromRow(row), result, input.now);
  });
}
