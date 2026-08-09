import { eq } from "drizzle-orm";

import type {
  FulfillmentHandler,
  FulfillmentInput,
} from "@/platform/commerce/application/order-fulfillment";
import type { DatabaseClient } from "@/platform/database/client";
import { commerceReconciliationRuns, commerceProducts, orders, payments } from "@/platform/database/commerce-schema";
import { refunds, subscriptionPeriods } from "@/platform/database/subscription-schema";
import { grantCredits, revokeSourceCredits } from "@/platform/credits/application/credit-service";
import type { CreditSource } from "@/platform/credits/domain/types";

export type CreditOrderFulfillmentDefinition = {
  readonly fulfillmentKey: string;
  readonly creditType: string;
  readonly quantity: number;
  readonly expiresAfterDays?: number;
};

async function creditSourceForPayment(
  database: DatabaseClient,
  paymentId: string,
  productModel: string,
  orderId: string,
): Promise<CreditSource> {
  if (productModel !== "subscription") return { type: "order", id: orderId };
  const periods = await database
    .select({ id: subscriptionPeriods.id })
    .from(subscriptionPeriods)
    .where(eq(subscriptionPeriods.paymentId, paymentId))
    .limit(2);
  if (periods.length !== 1 || !periods[0]) throw new Error("subscription period source is missing or ambiguous");
  return { type: "subscription_period", id: periods[0].id };
}

export function createCreditOrderFulfillment(
  database: DatabaseClient,
  definition: CreditOrderFulfillmentDefinition,
): FulfillmentHandler {
  return async (input: FulfillmentInput) => {
    if (input.sourceType !== "payment" && input.sourceType !== "subscription_payment") {
      throw new Error("credit fulfillment requires payment source");
    }
    const facts = await database
      .select({
        paymentId: payments.id,
        paymentStatus: payments.status,
        orderId: orders.id,
        orderStatus: orders.status,
        subjectId: orders.subjectId,
        paidAt: orders.paidAt,
        fulfillmentKey: commerceProducts.fulfillmentKey,
        productModel: commerceProducts.model,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(commerceProducts, eq(commerceProducts.id, orders.productId))
      .where(eq(payments.externalPaymentId, input.sourceId))
      .limit(2);
    if (facts.length !== 1 || !facts[0]) throw new Error("payment fulfillment source is missing or ambiguous");
    const fact = facts[0];
    if (fact.paymentStatus !== "succeeded" || fact.orderStatus !== "paid") {
      throw new Error("successful paid order is required for credit fulfillment");
    }
    if (fact.fulfillmentKey !== definition.fulfillmentKey) throw new Error("credit fulfillment definition mismatch");
    const base = fact.paidAt ?? new Date();
    const expiresAt = definition.expiresAfterDays
      ? new Date(base.getTime() + definition.expiresAfterDays * 86_400_000)
      : null;
    const source = await creditSourceForPayment(database, fact.paymentId, fact.productModel, fact.orderId);
    await grantCredits(database, {
      subjectId: fact.subjectId,
      creditType: definition.creditType,
      quantity: definition.quantity,
      source,
      idempotencyKey: `${source.type}-credit:${source.id}:${definition.creditType}`,
      expiresAt,
      actor: "system",
      metadata: { fulfillmentKey: definition.fulfillmentKey },
    });
  };
}

export function createCreditRefundReversal(
  database: DatabaseClient,
  definition: CreditOrderFulfillmentDefinition,
): FulfillmentHandler {
  return async (input: FulfillmentInput) => {
    if (input.sourceType !== "refund") throw new Error("credit reversal requires refund source");
    const rows = await database
      .select({
        refundId: refunds.id,
        reversalStatus: refunds.reversalStatus,
        paymentId: payments.id,
        orderId: orders.id,
        productModel: commerceProducts.model,
        fulfillmentKey: commerceProducts.fulfillmentKey,
      })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(commerceProducts, eq(commerceProducts.id, orders.productId))
      .where(eq(refunds.id, input.sourceId))
      .limit(2);
    if (rows.length !== 1 || !rows[0]) throw new Error("refund reversal source is missing or ambiguous");
    const row = rows[0];
    if (row.fulfillmentKey !== definition.fulfillmentKey) throw new Error("credit reversal definition mismatch");
    if (row.reversalStatus === "completed") return;
    const source = await creditSourceForPayment(database, row.paymentId, row.productModel, row.orderId);
    const result = await revokeSourceCredits(database, {
      source,
      correlationId: `refund:${row.refundId}`,
      actor: "system",
    });
    if (result.blocked === 0) {
      await database.update(refunds).set({ reversalStatus: "completed", operatorReviewReason: null, updatedAt: new Date() }).where(eq(refunds.id, row.refundId));
      return;
    }
    await database.transaction(async (tx) => {
      await tx.update(refunds).set({
        reversalStatus: "reconciliation_required",
        operatorReviewReason: `credit reversal blocked by ${result.blocked} consumed or reserved credits`,
        updatedAt: new Date(),
      }).where(eq(refunds.id, row.refundId));
      await tx.insert(commerceReconciliationRuns).values({
        targetType: "refund_entitlement",
        targetId: row.refundId,
        actorType: "worker",
        beforeJson: { reversalStatus: row.reversalStatus },
        afterJson: { reversalStatus: "reconciliation_required", revoked: result.revoked, blocked: result.blocked },
        result: "operator_review_required",
      });
    });
  };
}
