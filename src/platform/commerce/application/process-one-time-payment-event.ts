import { and, eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
  commerceReconciliationRuns,
  commerceProducts,
  fulfillmentJobs,
  orders,
  payments,
} from "@/platform/database/commerce-schema";

import type { NormalizedProviderEvent } from "../domain/events";
import { equalMoney, type SupportedCurrency } from "../domain/money";
import { transitionOrder, type OrderStatus } from "../domain/order";

type OneTimePaymentEvent = Extract<
  NormalizedProviderEvent,
  {
    type: "one_time_payment_succeeded" | "one_time_payment_failed" | "one_time_payment_canceled";
  }
>;

type CommerceTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function lockOrderForProviderEvent(tx: CommerceTransaction, event: OneTimePaymentEvent) {
  if (event.merchantOrderReference) {
    if (!isUuid(event.merchantOrderReference)) throw new Error("invalid merchant order reference");
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(eq(orders.id, event.merchantOrderReference), eq(orders.environment, event.environment)),
      )
      .limit(1)
      .for("update");
    if (!order) throw new Error("order not found for merchant reference");
    if (order.externalOrderId && order.externalOrderId !== event.externalOrderId) {
      throw new Error("provider order id mismatch");
    }
    return order;
  }

  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.environment, event.environment),
        eq(orders.externalOrderId, event.externalOrderId),
      ),
    )
    .limit(1)
    .for("update");
  if (!order) throw new Error("order not found for provider event");
  return order;
}

async function requireOneTimeProduct(tx: CommerceTransaction, productId: string) {
  const [product] = await tx
    .select({
      model: commerceProducts.model,
      fulfillmentKey: commerceProducts.fulfillmentKey,
    })
    .from(commerceProducts)
    .where(eq(commerceProducts.id, productId))
    .limit(1);
  if (!product) throw new Error("order product not found");
  if (product.model !== "one_time") {
    throw new Error("one-time payment event product model mismatch");
  }
  return product;
}

export async function processOneTimePaymentEvent(
  tx: CommerceTransaction,
  event: OneTimePaymentEvent,
  payloadHash: string,
): Promise<"applied" | "operator_review"> {
  if (event.type === "one_time_payment_succeeded") {
    const order = await lockOrderForProviderEvent(tx, event);
    const product = await requireOneTimeProduct(tx, order.productId);
    const expected = {
      currency: order.expectedCurrency as SupportedCurrency,
      minor: order.expectedMinor,
    };
    if (!equalMoney(expected, event.amount)) throw new Error("provider amount mismatch");

    const [succeededOrderPayment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, order.id), eq(payments.status, "succeeded")))
      .orderBy(payments.createdAt, payments.id)
      .limit(1)
      .for("update");
    if (
      succeededOrderPayment &&
      succeededOrderPayment.externalPaymentId !== event.externalPaymentId
    ) {
      await tx
        .insert(commerceReconciliationRuns)
        .values({
          dedupKey: `one-time-payment:${event.environment}:${order.id}:${event.externalPaymentId}:duplicate-succeeded`,
          targetType: "one_time_payment",
          targetId: order.id,
          actorType: "provider_event",
          beforeJson: {
            orderStatus: order.status,
            existingExternalPaymentId: succeededOrderPayment.externalPaymentId,
          },
          afterJson: {
            reason: "distinct_succeeded_payment_for_paid_order",
            existingExternalPaymentId: succeededOrderPayment.externalPaymentId,
            conflictingExternalPaymentId: event.externalPaymentId,
          },
          result: "operator_review_required",
        })
        .onConflictDoNothing();
      return "operator_review";
    }

    const [existingPayment] = await tx
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

    if (existingPayment) {
      if (
        existingPayment.orderId !== order.id ||
        existingPayment.currency !== event.amount.currency ||
        existingPayment.amountMinor !== event.amount.minor
      ) {
        throw new Error("provider payment identity mismatch");
      }
      await tx
        .update(payments)
        .set({ status: "succeeded", rawPayloadHash: payloadHash, updatedAt: new Date() })
        .where(eq(payments.id, existingPayment.id));
    } else {
      await tx.insert(payments).values({
        orderId: order.id,
        environment: event.environment,
        externalPaymentId: event.externalPaymentId,
        status: "succeeded",
        refundStatus: "none",
        currency: event.amount.currency,
        amountMinor: event.amount.minor,
        refundedMinor: 0n,
        providerCreatedAt: event.occurredAt,
        rawPayloadHash: payloadHash,
      });
    }

    await tx
      .update(orders)
      .set({
        status: transitionOrder(parseOrderStatus(order.status), "payment_succeeded"),
        externalOrderId: order.externalOrderId ?? event.externalOrderId,
        paidAt: order.paidAt ?? event.occurredAt,
      })
      .where(eq(orders.id, order.id));

    const operation = `fulfill:${product.fulfillmentKey}`;
    await tx
      .insert(fulfillmentJobs)
      .values({
        sourceType: "payment",
        sourceId: event.externalPaymentId,
        operation,
        idempotencyKey: `payment:${event.environment}:${event.externalPaymentId}:${operation}`,
      })
      .onConflictDoNothing({ target: fulfillmentJobs.idempotencyKey });
    return "applied";
  }

  const order = await lockOrderForProviderEvent(tx, event);
  await requireOneTimeProduct(tx, order.productId);
  if (event.type === "one_time_payment_canceled") {
    await tx
      .update(orders)
      .set({
        status: transitionOrder(parseOrderStatus(order.status), "payment_canceled"),
        externalOrderId: order.externalOrderId ?? event.externalOrderId,
        canceledAt: event.occurredAt,
      })
      .where(eq(orders.id, order.id));
  }
  return "applied";
}
