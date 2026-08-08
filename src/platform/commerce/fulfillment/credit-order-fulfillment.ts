import { eq } from "drizzle-orm";

import type {
  FulfillmentHandler,
  FulfillmentInput,
} from "@/platform/commerce/application/order-fulfillment";
import type { DatabaseClient } from "@/platform/database/client";
import { commerceProducts, orders, payments } from "@/platform/database/commerce-schema";
import { grantCredits } from "@/platform/credits/application/credit-service";

export type CreditOrderFulfillmentDefinition = {
  readonly fulfillmentKey: string;
  readonly creditType: string;
  readonly quantity: number;
  readonly expiresAfterDays?: number;
};

export function createCreditOrderFulfillment(
  database: DatabaseClient,
  definition: CreditOrderFulfillmentDefinition,
): FulfillmentHandler {
  return async (input: FulfillmentInput) => {
    if (input.sourceType !== "payment") {
      throw new Error("credit fulfillment requires payment source");
    }
    const facts = await database
      .select({
        paymentStatus: payments.status,
        orderId: orders.id,
        orderStatus: orders.status,
        subjectId: orders.subjectId,
        paidAt: orders.paidAt,
        fulfillmentKey: commerceProducts.fulfillmentKey,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(commerceProducts, eq(commerceProducts.id, orders.productId))
      .where(eq(payments.externalPaymentId, input.sourceId))
      .limit(2);
    if (facts.length !== 1) {
      throw new Error("payment fulfillment source is missing or ambiguous");
    }
    const fact = facts[0];
    if (!fact || fact.paymentStatus !== "succeeded" || fact.orderStatus !== "paid") {
      throw new Error("successful paid order is required for credit fulfillment");
    }
    if (fact.fulfillmentKey !== definition.fulfillmentKey) {
      throw new Error("credit fulfillment definition mismatch");
    }
    const base = fact.paidAt ?? new Date();
    const expiresAt = definition.expiresAfterDays
      ? new Date(base.getTime() + definition.expiresAfterDays * 24 * 60 * 60 * 1000)
      : null;
    await grantCredits(database, {
      subjectId: fact.subjectId,
      creditType: definition.creditType,
      quantity: definition.quantity,
      source: { type: "order", id: fact.orderId },
      idempotencyKey: `order-credit:${fact.orderId}:${definition.creditType}`,
      expiresAt,
      actor: "system",
      metadata: { fulfillmentKey: definition.fulfillmentKey },
    });
  };
}
