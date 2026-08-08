import { and, eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { fulfillmentJobs, orders, payments } from "@/platform/database/commerce-schema";

import { equalMoney } from "../domain/money";
import { transitionOrder } from "../domain/order";
import type { NormalizedProviderEvent } from "../domain/events";

export async function processProviderEvent(
  database: DatabaseClient,
  event: NormalizedProviderEvent,
  payloadHash: string,
): Promise<void> {
  if (event.type === "unsupported_signed_event") return;

  await database.transaction(async (tx) => {
    if (event.type === "one_time_payment_succeeded") {
      const order = await tx.query.orders.findFirst({
        where: and(
          eq(orders.environment, event.environment),
          eq(orders.externalOrderId, event.externalOrderId),
        ),
      });
      if (!order) throw new Error("order not found for payment event");
      const expected = {
        currency: order.expectedCurrency as typeof event.amount.currency,
        minor: order.expectedMinor,
      };
      if (!equalMoney(expected, event.amount)) throw new Error("provider amount mismatch");

      await tx
        .insert(payments)
        .values({
          orderId: order.id,
          environment: event.environment,
          externalPaymentId: event.externalPaymentId,
          status: "succeeded",
          refundStatus: "none",
          currency: event.amount.currency,
          amountMinor: event.amount.minor,
          providerCreatedAt: event.occurredAt,
          rawPayloadHash: payloadHash,
        })
        .onConflictDoUpdate({
          target: [payments.environment, payments.externalPaymentId],
          set: {
            status: "succeeded",
            rawPayloadHash: payloadHash,
            updatedAt: new Date(),
          },
        });

      await tx
        .update(orders)
        .set({
          status: transitionOrder(order.status as never, "payment_succeeded"),
          paidAt: order.paidAt ?? event.occurredAt,
        })
        .where(eq(orders.id, order.id));

      await tx
        .insert(fulfillmentJobs)
        .values({
          sourceType: "payment",
          sourceId: event.externalPaymentId,
          operation: "fulfill",
          idempotencyKey: `payment:${event.environment}:${event.externalPaymentId}:fulfill`,
        })
        .onConflictDoNothing({ target: fulfillmentJobs.idempotencyKey });
      return;
    }

    if (event.type === "one_time_payment_failed" || event.type === "one_time_payment_canceled") {
      const order = await tx.query.orders.findFirst({
        where: and(
          eq(orders.environment, event.environment),
          eq(orders.externalOrderId, event.externalOrderId),
        ),
      });
      if (!order) throw new Error("order not found for failure event");
      if (event.type === "one_time_payment_canceled") {
        await tx
          .update(orders)
          .set({
            status: transitionOrder(order.status as never, "payment_canceled"),
            canceledAt: event.occurredAt,
          })
          .where(eq(orders.id, order.id));
      }
      return;
    }

    const payment = await tx.query.payments.findFirst({
      where: and(
        eq(payments.environment, event.environment),
        eq(payments.externalPaymentId, event.externalPaymentId),
      ),
    });
    if (!payment) throw new Error("payment not found for refund event");

    if (event.type === "refund_failed") {
      await tx
        .update(payments)
        .set({ refundStatus: "failed", updatedAt: new Date() })
        .where(eq(payments.id, payment.id));
      return;
    }

    const order = await tx.query.orders.findFirst({ where: eq(orders.id, payment.orderId) });
    if (!order) throw new Error("order not found for refund event");
    if (
      event.amount.currency !== payment.currency ||
      event.amount.minor <= 0n ||
      event.amount.minor > payment.amountMinor
    ) {
      throw new Error("invalid refund amount");
    }
    const full = event.amount.minor === payment.amountMinor;
    await tx
      .update(payments)
      .set({ refundStatus: full ? "refunded" : "partial", updatedAt: new Date() })
      .where(eq(payments.id, payment.id));
    await tx
      .update(orders)
      .set({
        status: transitionOrder(
          order.status as never,
          full ? "refund_full_succeeded" : "refund_partial_succeeded",
        ),
      })
      .where(eq(orders.id, order.id));
  });
}
