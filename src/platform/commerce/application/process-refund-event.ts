import { and, eq, inArray, or } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
  commerceProducts,
  commerceReconciliationRuns,
  fulfillmentJobs,
  orders,
  payments,
} from "@/platform/database/commerce-schema";
import { refunds, subscriptionPeriods } from "@/platform/database/subscription-schema";

import type { NormalizedProviderEvent } from "../domain/events";
import { transitionOrder, type OrderStatus } from "../domain/order";
import type { Money } from "../domain/money";

type RefundEvent = Extract<NormalizedProviderEvent, { type: "refund_succeeded" | "refund_failed" }>;
type RefundSettlementEvent<T = RefundEvent> = T extends unknown
  ? Omit<T, "eventId"> & { readonly eventId?: string }
  : never;
type CommerceTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];
type RefundRow = typeof refunds.$inferSelect;
type PaymentRefundStatus = "none" | "partial" | "refunded" | "failed";

export type RefundSettlementSource = "webhook" | "provider_read_reconciliation";

type RefundSettlementContext = {
  readonly source: RefundSettlementSource;
  readonly refundId?: string;
};

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

async function matchingRefunds(
  tx: CommerceTransaction,
  paymentId: string,
  event: RefundSettlementEvent,
  refundId?: string,
) {
  if (refundId) {
    return tx
      .select()
      .from(refunds)
      .where(
        and(
          eq(refunds.id, refundId),
          eq(refunds.paymentId, paymentId),
          eq(refunds.environment, event.environment),
        ),
      )
      .limit(2)
      .for("update");
  }
  if (event.externalRefundReference) {
    return tx
      .select()
      .from(refunds)
      .where(
        and(
          eq(refunds.environment, event.environment),
          or(
            eq(refunds.externalRefundReference, event.externalRefundReference),
            eq(refunds.externalSettlementReference, event.externalRefundReference),
          ),
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
    readonly source?: RefundSettlementSource;
  },
): Promise<void> {
  await tx.insert(commerceReconciliationRuns).values({
    targetType: input.targetType,
    targetId: input.targetId,
    actorType:
      input.source === "provider_read_reconciliation" ? "provider_read_reconciliation" : "webhook",
    beforeJson: input.before,
    afterJson: input.after,
    result: "operator_review_required",
  });
}

async function handleSettledRefundReplay(
  tx: CommerceTransaction,
  refund: RefundRow,
  event: Extract<RefundSettlementEvent, { type: "refund_succeeded" }>,
  source: RefundSettlementSource,
): Promise<boolean> {
  if (refund.status !== "succeeded") return false;
  const sameAmount = refund.succeededMinor === event.amount.minor;
  const sameCurrency = refund.currency === event.amount.currency;
  const sameReference =
    !event.externalRefundReference ||
    refund.externalRefundReference === event.externalRefundReference ||
    refund.externalSettlementReference === event.externalRefundReference;
  if (sameAmount && sameCurrency && sameReference) return true;

  await recordRefundReconciliation(tx, {
    targetType: "payment_refund",
    targetId: refund.paymentId,
    source,
    before: {
      refundId: refund.id,
      succeededMinor: refund.succeededMinor.toString(),
      currency: refund.currency,
      externalRefundReference: refund.externalRefundReference,
    },
    after: {
      conflictingProviderSuccess: true,
      eventAmountMinor: event.amount.minor.toString(),
      eventCurrency: event.amount.currency,
      eventExternalRefundReference: event.externalRefundReference ?? null,
    },
  });
  return true;
}

async function processRefundEventInternal(
  tx: CommerceTransaction,
  event: RefundSettlementEvent,
  context: RefundSettlementContext,
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

  if (event.merchantOrderReference && event.merchantOrderReference !== order.id) {
    await recordRefundReconciliation(tx, {
      targetType: "payment_refund",
      targetId: payment.id,
      source: context.source,
      before: {
        orderId: order.id,
        refundStatus: payment.refundStatus,
        refundedMinor: payment.refundedMinor.toString(),
      },
      after: {
        reason: "merchant_order_reference_payment_mismatch",
        externalPaymentId: event.externalPaymentId,
        expectedMerchantOrderReference: order.id,
        eventMerchantOrderReference: event.merchantOrderReference,
      },
    });
    return;
  }

  const candidates = await matchingRefunds(tx, payment.id, event, context.refundId);
  const matched = candidates.length === 1 ? candidates[0]! : undefined;

  if (context.refundId && !matched) {
    throw new Error("provider refund settlement target not found");
  }

  if (matched && matched.paymentId !== payment.id) {
    await recordRefundReconciliation(tx, {
      targetType: "payment_refund",
      targetId: payment.id,
      source: context.source,
      before: { refundStatus: payment.refundStatus },
      after: {
        reason: "external_refund_reference_payment_mismatch",
        refundId: matched.id,
        matchedPaymentId: matched.paymentId,
        eventPaymentId: payment.id,
        externalRefundReference: event.externalRefundReference ?? null,
      },
    });
    return;
  }

  if (event.type === "refund_failed") {
    if (matched?.status === "succeeded") {
      const stale = Boolean(
        matched.providerUpdatedAt && event.occurredAt <= matched.providerUpdatedAt,
      );
      if (!stale) {
        await recordRefundReconciliation(tx, {
          targetType: "payment_refund",
          targetId: payment.id,
          source: context.source,
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
          providerWriteState: "confirmed",
          nextProviderReconciliationAt: null,
          reconciliationLeaseOwner: null,
          reconciliationLeaseExpiresAt: null,
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
          reconciliationLeaseOwner: null,
          reconciliationLeaseExpiresAt: null,
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
        source: context.source,
        before: { refundStatus: payment.refundStatus },
        after: { ambiguousFailedRefund: true, candidateCount: candidates.length },
      });
    } else if (event.externalRefundReference) {
      await recordRefundReconciliation(tx, {
        targetType: "payment_refund",
        targetId: payment.id,
        source: context.source,
        before: { refundStatus: payment.refundStatus },
        after: {
          unmatchedFailedRefund: true,
          externalRefundReference: event.externalRefundReference,
        },
      });
    }
    return;
  }

  if (matched && (await handleSettledRefundReplay(tx, matched, event, context.source))) return;

  if (event.amount.currency !== payment.currency || event.amount.minor <= 0n) {
    throw new Error("invalid refund amount");
  }
  const refundedMinor = payment.refundedMinor + event.amount.minor;
  if (refundedMinor > payment.amountMinor) throw new Error("refund exceeds captured payment");
  const full = refundedMinor === payment.amountMinor;

  const [product] = await tx
    .select({ fulfillmentKey: commerceProducts.fulfillmentKey, model: commerceProducts.model })
    .from(commerceProducts)
    .where(eq(commerceProducts.id, order.productId))
    .limit(1);
  if (!product) throw new Error("refund order product not found");

  let refund = matched;
  if (!refund) {
    if (!event.eventId) throw new Error("provider-originated refund event missing event id");
    if (candidates.length > 1) {
      await tx
        .update(refunds)
        .set({
          status: "reconciliation_required",
          reversalStatus: "reconciliation_required",
          operatorReviewReason: "ambiguous successful refund webhook",
          reconciliationLeaseOwner: null,
          reconciliationLeaseExpiresAt: null,
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
        source: context.source,
        before: { refundedMinor: payment.refundedMinor.toString() },
        after: {
          refundedMinor: refundedMinor.toString(),
          unmatchedRefund: true,
          candidateCount: candidates.length,
        },
      });
    }
    const [providerRefund] = await tx
      .insert(refunds)
      .values({
        paymentId: payment.id,
        subjectId: order.subjectId,
        environment: event.environment,
        externalRefundReference: event.externalRefundReference,
        externalSettlementReference: event.externalRefundReference,
        idempotencyKey: `provider-refund:${event.environment}:${event.eventId}`,
        currency: event.amount.currency,
        requestedMinor: event.amount.minor,
        succeededMinor: event.amount.minor,
        reason: "provider-originated refund",
        status: "succeeded",
        reversalStatus: full ? "pending" : "reconciliation_required",
        providerWriteState: "confirmed",
        operatorReviewReason: full
          ? null
          : "partial refund entitlement reversal requires operator policy",
        providerUpdatedAt: event.occurredAt,
      })
      .returning();
    if (!providerRefund) throw new Error("provider refund insert failed");
    refund = providerRefund;
  }

  if (event.amount.minor > refund.requestedMinor) {
    throw new Error("refund webhook exceeds requested refund amount");
  }

  if (product.model === "subscription" && full) {
    const periods = await tx
      .select({ id: subscriptionPeriods.id })
      .from(subscriptionPeriods)
      .where(eq(subscriptionPeriods.paymentId, payment.id))
      .limit(2)
      .for("update");
    if (periods.length !== 1) {
      throw new Error("unique subscription period not found for refunded payment");
    }
    await tx
      .update(subscriptionPeriods)
      .set({ state: "refunded" })
      .where(eq(subscriptionPeriods.id, periods[0]!.id));
  }

  await tx
    .update(payments)
    .set({
      refundedMinor,
      refundStatus: full ? "refunded" : "partial",
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));
  if (product.model === "one_time") {
    await tx
      .update(orders)
      .set({
        status: transitionOrder(
          parseOrderStatus(order.status),
          full ? "refund_full_succeeded" : "refund_partial_succeeded",
        ),
      })
      .where(eq(orders.id, order.id));
  }

  if (!full) {
    await tx
      .update(refunds)
      .set({
        status: "succeeded",
        succeededMinor: event.amount.minor,
        reversalStatus: "reconciliation_required",
        providerWriteState: "confirmed",
        externalSettlementReference:
          context.source === "webhook" ? event.externalRefundReference : undefined,
        nextProviderReconciliationAt: null,
        reconciliationLeaseOwner: null,
        reconciliationLeaseExpiresAt: null,
        operatorReviewReason: "partial refund entitlement reversal requires operator policy",
        providerUpdatedAt: event.occurredAt,
        updatedAt: new Date(),
      })
      .where(eq(refunds.id, refund.id));
    await recordRefundReconciliation(tx, {
      targetType: "refund_entitlement",
      targetId: refund.id,
      source: context.source,
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
      providerWriteState: "confirmed",
      externalSettlementReference:
        context.source === "webhook" ? event.externalRefundReference : undefined,
      operatorReviewReason: null,
      nextProviderReconciliationAt: null,
      reconciliationLeaseOwner: null,
      reconciliationLeaseExpiresAt: null,
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

export async function processRefundEvent(
  tx: CommerceTransaction,
  event: RefundEvent,
): Promise<void> {
  await processRefundEventInternal(tx, event, { source: "webhook" });
}

export async function applyProviderReadRefundSettlementInTransaction(
  tx: CommerceTransaction,
  input: {
    readonly refundId: string;
    readonly environment: "test" | "production";
    readonly externalPaymentId: string;
    readonly merchantOrderReference: string;
    readonly externalRefundReference?: string;
    readonly amount: Money;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await processRefundEventInternal(
    tx,
    {
      type: "refund_succeeded",
      environment: input.environment,
      externalPaymentId: input.externalPaymentId,
      merchantOrderReference: input.merchantOrderReference,
      ...(input.externalRefundReference
        ? { externalRefundReference: input.externalRefundReference }
        : {}),
      amount: input.amount,
      occurredAt: input.occurredAt,
    },
    { source: "provider_read_reconciliation", refundId: input.refundId },
  );
}
