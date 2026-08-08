import { and, eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { orders } from "@/platform/database/commerce-schema";

import type { ProductCatalog } from "./product-catalog";
import type { PaymentProvider } from "./payment-provider";
import { ensureCommerceProduct } from "./sync-product-catalog";
import type { CommerceEnvironment } from "../domain/product";

export type CreateCheckoutInput = {
  readonly subjectId: string;
  readonly buyerIdentity: string;
  readonly buyerEmail?: string;
  readonly productKey: string;
  readonly environment: CommerceEnvironment;
  readonly idempotencyKey: string;
  readonly appOrigin: string;
};

export type CheckoutResult = {
  readonly orderId: string;
  readonly checkoutUrl: string;
  readonly reused: boolean;
};

function validateIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9:_-]{16,128}$/.test(value)) throw new Error("invalid checkout idempotency key");
}

export async function createCheckout(
  input: CreateCheckoutInput,
  dependencies: {
    readonly database: DatabaseClient;
    readonly catalog: ProductCatalog;
    readonly provider: PaymentProvider;
  },
): Promise<CheckoutResult> {
  validateIdempotencyKey(input.idempotencyKey);
  const { database, catalog, provider } = dependencies;

  const existing = await database.query.orders.findFirst({
    where: and(
      eq(orders.checkoutIdempotencyKey, input.idempotencyKey),
      eq(orders.subjectId, input.subjectId),
    ),
  });
  if (existing?.externalCheckoutSessionId) {
    throw new Error("existing checkout session requires provider lookup before reuse");
  }
  if (existing && existing.subjectId !== input.subjectId) {
    throw new Error("checkout idempotency collision");
  }

  const snapshot = catalog.getEnabled(input.productKey, input.environment);
  if (snapshot.commercialModel !== "one_time") throw new Error("product is not one-time");
  const product = await ensureCommerceProduct(database, snapshot, input.environment);

  const order =
    existing ??
    (
      await database
        .insert(orders)
        .values({
          subjectId: input.subjectId,
          productId: product.id,
          environment: input.environment,
          expectedCurrency: snapshot.expected.currency,
          expectedMinor: snapshot.expected.minor,
          checkoutIdempotencyKey: input.idempotencyKey,
        })
        .returning()
    )[0];
  if (!order) throw new Error("order insert failed");

  const successUrl = new URL(
    `/checkout/return?order=${encodeURIComponent(order.id)}`,
    input.appOrigin,
  ).toString();
  const cancelUrl = new URL(
    `/checkout/return?order=${encodeURIComponent(order.id)}&canceled=1`,
    input.appOrigin,
  ).toString();
  const checkout = await provider.createOneTimeCheckout({
    localOrderId: order.id,
    providerProductId: snapshot.providerProductId,
    expectedDisplayAmount: snapshot.expectedDisplayAmount,
    currency: snapshot.expected.currency,
    buyerIdentity: input.buyerIdentity,
    ...(input.buyerEmail ? { buyerEmail: input.buyerEmail } : {}),
    successUrl,
    cancelUrl,
  });
  const target = new URL(checkout.checkoutUrl);
  if (target.protocol !== "https:") throw new Error("provider checkout URL must use HTTPS");

  await database
    .update(orders)
    .set({
      externalCheckoutSessionId: checkout.externalCheckoutSessionId,
      ...(checkout.externalOrderId ? { externalOrderId: checkout.externalOrderId } : {}),
    })
    .where(eq(orders.id, order.id));

  return { orderId: order.id, checkoutUrl: checkout.checkoutUrl, reused: Boolean(existing) };
}
