import { and, eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { commerceAppliedEvents } from "@/platform/database/commerce-event-schema";
import {
  commerceProducts,
  fulfillmentJobs,
  orders,
  payments,
} from "@/platform/database/commerce-schema";

import type { NormalizedProviderEvent } from "../domain/events";
import { equalMoney, type SupportedCurrency } from "../domain/money";
import { transitionOrder, type OrderStatus } from "../domain/order";

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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function lockOrderForProviderEvent(
  tx: Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0],
  event: Extract<
    NormalizedProviderEvent,
    {
      type:
        | "one_time_payment_succeeded"
        | "one_time_payment_failed"
        | "one_time_payment_canceled";
    }
  >,
) {
  if (event.merchantOrderReference) {
    if (!isUuid(event.merchantOrderReference)) throw new Error("invalid merchant order reference");
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.id, event.merchantOrderReference),
          eq(orders.environment, event.environment),
        ),
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

export async function processProviderEvent(
  database: DatabaseClient,
  event: NormalizedProviderEvent,
  payloadHash: string,
): Promise<void> {
  if (event.type === "unsupported_signed_event") return;

  await database.transaction(async (tx) => {
    const [application] = await tx
      .insert(commerceAppliedEvents)
      .values({
        environment: event.environment,
        providerEventId: event.eventId,
        eventType: event.type,
        payloadHash,
      })
      .onConflictDoNothing({
        target: [commerceAppliedEvents.environment, commerceAppliedEvents.providerEventId],
      })
      .returning({ id: commerceAppliedEvents.id });
    if (!application) return;

    if (event.type === "one_time_payment_succeeded") {
      const order = await lockOrderForProviderEvent(tx, event);
      const expected = {
        currency: order.expectedCurrency as SupportedCurrency,
        minor: order.expectedMinor,
      };
      if (!equalMoney(expected, event.amount)) throw new Error("provider amount mismatch");

      const [product] = await tx
        .select({ fulfillmentKey: commerceProducts.fulfillmentKey })
        .from(commerceProducts)
        .where(eq(commerceProducts.id, order.productId))
        .limit(1);
      if (!product) throw new Error("order product not found");

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
      return;
    }

    if (event.type === "one_time_payment_failed" || event.type === "one_time_payment_canceled") {
      const order = await lockOrderForProviderEvent(tx, event);
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
      return;
    }

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

    if (event.type === "refund_failed") {
      await tx
        .update(payments)
        .set({ refundStatus: "failed", updatedAt: new Date() })
        .where(eq(payments.id, payment.id));
      return;
    }

    if (event.amount.currency !== payment.currency || event.amount.minor <= 0n) {
      throw new Error("invalid refund amount");
    }
    const refundedMinor = payment.refundedMinor + event.amount.minor;
    if (refundedMinor > payment.amountMinor) throw new Error("refund exceeds captured payment");

    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, payment.orderId))
      .limit(1)
      .for("update");
    if (!order) throw new Error("order not found for refund event");

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
  });
}
