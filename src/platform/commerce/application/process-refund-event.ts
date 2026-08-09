import { and, eq, inArray } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
  commerceProducts,
  commerceReconciliationRuns,
  fulfillmentJobs,
  orders,
  payments,
} from "@/platform/database/commerce-schema";
import { refunds } from "@/platform/database/subscription-schema";

import type { NormalizedProviderEvent } from "../domain/events";
import { transitionOrder, type OrderStatus } from "../domain/order";

type RefundEvent = Extract<NormalizedProviderEvent, { type: "refund_succeeded" | "refund_failed" }>;
type CommerceTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];
type RefundRow = typeof refunds.$inferSelect;
type PaymentRefundStatus = "none" | "partial" | "refunded" | "failed";

function parseOrderStatus(value: string): OrderStatus {
  if (
    value === "pending" ||
    value === "paid" ||
    value === "canceled" ||
    value === "partially_refunded" ||
    value === "refunded"
  ) {
    return value;
  }
  throw new Error(`invalid persisted order status: ${value}`);
}

function aggregateRefundStatus(payment: typeof payments.$inferSelect): PaymentRefundStatus {
  if (payment.refundedMinor === payment.amountMinor && payment.amountMinor > 0n) return "refunded";
  if (payment.refundedMinor > 0n) return "partial";
  return "failed";
}

async function matchingRefunds(tx: CommerceTransaction, paymentId: string, event: RefundEvent) {
  if (event.externalRefundReference) {
    return tx
      .select()
      .from(refunds)
      .where(
        and(
          eq(refunds.environment, event.environment),
          eq(refunds.externalRefundReference, event.externalRefundReference),
        ),
      )
      .limit(2)
      .for("update");
  }
  const candidates = await tx
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.paymentId, paymentId),
        eq(refunds.environment, event.environment),
        inArray(refunds.status, ["pending", "processing"]),
      ),
    )
    .for("update");
  if (event.type === "refund_failed") return candidates;
  return candidates.filter((candidate) => candidate.requestedMinor === event.amount.minor);
}

async function recordRefundReconciliation(
  tx: CommerceTransaction,
  input: {
    readonly targetId: string;
    readonly targetType: "payment_refund" | "refund_entitlement";
    readonly before: Record<string, unknown>;
    readonly after: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(commerceReconciliationRuns).values({
    targetType: input.targetType,
    targetId: input.targetId,
    actorType: "webhook",
    beforeJson: input.before,
    afterJson: input.after,
    result: "operator_review_required",
  });
}

async function handleSettledRefundReplay(
  tx: CommerceTransaction,
  refund: RefundRow,
  event: Extract<RefundEvent, { type: "refund_succeeded" }>,
): Promise<boolean> {
  if (refund.status !== "succeeded") return false;
  const sameAmount = refund.succeededMinor === event.amount.minor;
  const sameReference =
    !event.externalRefundReference || refund.externalRefundReference === event.externalRefundReference;
  if (sameAmount && sameReference) return true;

  await recordRefundReconciliation(tx, {
    targetType: "payment_refund",
    targetId: refund.paymentId,
    before: {
      refundId: refund.id,
      succeededMinor: refund.succeededMinor.toString(),
      externalRefundReference: refund.externalRefundReference,
    },
    after: {
      conflictingProviderSuccess: true,
      eventAmountMinor: event.amount.minor.toString(),
      eventExternalRefundReference: event.externalRefundReference ?? null,
    },
  });
  return true;
}

export async function processRefundEvent(
  tx: CommerceTransaction,
  event: RefundEvent,
): Promise<void> {
  const [payment] = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.environment, event.environment),
        eq(payments.externalPaymentId, event.externalPaymentId),
      ),
    )
    .limit(1)
    .for("update");
  if (!payment) throw new Error("payment not found for refund event");

  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, payment.orderId))
    .limit(1)
    .for("update");
  if (!order) throw new Error("order not found for refund event");

  const candidates = await matchingRefunds(tx, payment.id, event);
  const matched = candidates.length === 1 ? candidates[0]! : undefined;

  if (event.type === "refund_failed") {
    if (matched?.status === "succeeded") {
      const stale = Boolean(
        matched.providerUpdatedAt && event.occurredAt <= matched.providerUpdatedAt,
      );
      if (!stale) {
        await recordRefundReconciliation(tx, {
          targetType: "payment_refund",
          targetId: payment.id,
          before: {
            refundId: matched.id,
            status: matched.status,
            succeededMinor: matched.succeededMinor.toString(),
          },
          after: {
            contradictoryFailureAfterSuccess: true,
            providerOccurredAt: event.occurredAt.toISOString(),
          },
        });
      }
      return;
    }

    await tx
      .update(payments)
      .set({ refundStatus: aggregateRefundStatus(payment), updatedAt: new Date() })
      .where(eq(payments.id, payment.id));
    if (matched) {
      await tx
        .update(refunds)
        .set({
          status: "failed",
          reversalStatus: "not_required",
          providerUpdatedAt: event.occurredAt,
          updatedAt: new Date(),
        })
        .where(eq(refunds.id, matched.id));
    } else if (candidates.length > 1) {
      await tx
        .update(refunds)
        .set({
          status: "reconciliation_required",
          reversalStatus: "reconciliation_required",
          operatorReviewReason: "ambiguous failed refund webhook",
          updatedAt: new Date(),
        })
        .where(
          inArray(
            refunds.id,
            candidates.map((candidate) => candidate.id),
          ),
        );
      await recordRefundReconciliation(tx, {
        targetType: "payment_refund",
        targetId: payment.id,
        before: { refundStatus: payment.refundStatus },
        after: { ambiguousFailedRefund: true, candidateCount: candidates.length },
      });
    } else if (event.externalRefundReference) {
      await recordRefundReconciliation(tx, {
        targetType: "payment_refund",
        targetId: payment.id,
        before: { refundStatus: payment.refundStatus },
        after: {
          unmatchedFailedRefund: true,
          externalRefundReference: event.externalRefundReference,
        },
      });
    }
    return;
  }

  if (matched && (await handleSettledRefundReplay(tx, matched, event))) return;

  if (event.amount.currency !== payment.currency || event.amount.minor <= 0n) {
    throw new Error("invalid refund amount");
  }
  const refundedMinor = payment.refundedMinor + event.amount.minor;
  if (refundedMinor > payment.amountMinor) throw new Error("refund exceeds captured payment");
  const full = refundedMinor === payment.amountMinor;

  await tx
    .update(payments)
    .set({
      refundedMinor,
      refundStatus: full ? "refunded" : "partial",
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));
  await tx
    .update(orders)
    .set({
      status: transitionOrder(
        parseOrderStatus(order.status),
        full ? "refund_full_succeeded" : "refund_partial_succeeded",
      ),
    })
    .where(eq(orders.id, order.id));

  const [product] = await tx
    .select({ fulfillmentKey: commerceProducts.fulfillmentKey })
    .from(commerceProducts)
    .where(eq(commerceProducts.id, order.productId))
    .limit(1);
  if (!product) throw new Error("refund order product not found");

  if (!matched) {
    if (candidates.length > 1) {
      await tx
        .update(refunds)
        .set({
          status: "reconciliation_required",
          reversalStatus: "reconciliation_required",
          operatorReviewReason: "ambiguous successful refund webhook",
          updatedAt: new Date(),
        })
        .where(
          inArray(
            refunds.id,
            candidates.map((candidate) => candidate.id),
          ),
        );
    }
    await recordRefundReconciliation(tx, {
      targetType: "payment_refund",
      targetId: payment.id,
      before: { refundedMinor: payment.refundedMinor.toString() },
      after: {
        refundedMinor: refundedMinor.toString(),
        unmatchedRefund: true,
        candidateCount: candidates.length,
      },
    });
    return;
  }

  const refund = matched;
  if (event.amount.minor > refund.requestedMinor) {
    throw new Error("refund webhook exceeds requested refund amount");
  }

  if (!full) {
    await tx
      .update(refunds)
      .set({
        status: "succeeded",
        succeededMinor: event.amount.minor,
        reversalStatus: "reconciliation_required",
        operatorReviewReason: "partial refund entitlement reversal requires operator policy",
        providerUpdatedAt: event.occurredAt,
        updatedAt: new Date(),
      })
      .where(eq(refunds.id, refund.id));
    await recordRefundReconciliation(tx, {
      targetType: "refund_entitlement",
      targetId: refund.id,
      before: { reversalStatus: refund.reversalStatus },
      after: { reversalStatus: "reconciliation_required", reason: "partial_refund" },
    });
    return;
  }

  await tx
    .update(refunds)
    .set({
      status: "succeeded",
      succeededMinor: event.amount.minor,
      reversalStatus: "pending",
      providerUpdatedAt: event.occurredAt,
      updatedAt: new Date(),
    })
    .where(eq(refunds.id, refund.id));
  const operation = `reverse:${product.fulfillmentKey}`;
  await tx
    .insert(fulfillmentJobs)
    .values({
      sourceType: "refund",
      sourceId: refund.id,
      operation,
      idempotencyKey: `refund:${refund.id}:${operation}`,
    })
    .onConflictDoNothing({ target: fulfillmentJobs.idempotencyKey });
}
