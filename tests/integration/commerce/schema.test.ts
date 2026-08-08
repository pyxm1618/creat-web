import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceProducts,
  fulfillmentJobs,
  orders,
  paymentWebhookInbox,
  payments,
} from "@/platform/database/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabaseClient(databaseUrl);

beforeAll(async () => {
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS public CASCADE"));
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS drizzle CASCADE"));
  await database.db.execute(sql.raw("CREATE SCHEMA public"));
  await migrate(database.db, {
    migrationsFolder: "drizzle",
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
});

afterAll(async () => database.close());

async function seedOrder() {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `product-${crypto.randomUUID()}`,
      version: 1,
      model: "one_time",
      environment: "test",
      providerProductId: `provider-${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor: 299n,
      fulfillmentKey: "starter",
      refundPolicyKey: "default",
    })
    .returning();
  if (!product) throw new Error("product insert failed");
  const [order] = await database.db
    .insert(orders)
    .values({
      subjectId: subject.id,
      productId: product.id,
      environment: "test",
      expectedCurrency: "USD",
      expectedMinor: 299n,
      checkoutIdempotencyKey: `checkout:${crypto.randomUUID()}`,
      externalOrderId: `external-order-${crypto.randomUUID()}`,
    })
    .returning();
  if (!order) throw new Error("order insert failed");
  return { subject, product, order };
}

it("rejects invalid money and environment at database level", async () => {
  await expect(
    database.db.insert(commerceProducts).values({
      key: "bad",
      version: 1,
      model: "one_time",
      environment: "test",
      providerProductId: "bad-product",
      currency: "USD",
      expectedMinor: -1n,
      fulfillmentKey: "bad",
      refundPolicyKey: "bad",
    }),
  ).rejects.toThrow();
});

it("enforces checkout, payment, webhook and fulfillment idempotency", async () => {
  const { order } = await seedOrder();
  await expect(
    database.db.insert(orders).values({
      subjectId: order.subjectId,
      productId: order.productId,
      environment: "test",
      expectedCurrency: "USD",
      expectedMinor: 299n,
      checkoutIdempotencyKey: order.checkoutIdempotencyKey,
    }),
  ).rejects.toThrow();

  const paymentValues = {
    orderId: order.id,
    environment: "test",
    externalPaymentId: `payment-${crypto.randomUUID()}`,
    status: "succeeded",
    refundStatus: "none",
    currency: "USD",
    amountMinor: 299n,
    rawPayloadHash: "a".repeat(64),
  } as const;
  await database.db.insert(payments).values(paymentValues);
  await expect(database.db.insert(payments).values(paymentValues)).rejects.toThrow();

  const webhookValues = {
    environment: "test",
    providerEventId: `event-${crypto.randomUUID()}`,
    dedupHash: crypto.randomUUID().replaceAll("-", ""),
    eventType: "one_time_payment_succeeded",
    signatureValid: true,
    normalizedPayloadJson: {},
    payloadHash: "b".repeat(64),
    payloadSizeBytes: 20,
    retentionClass: "normalized_only",
  } as const;
  await database.db.insert(paymentWebhookInbox).values(webhookValues);
  await expect(database.db.insert(paymentWebhookInbox).values(webhookValues)).rejects.toThrow();

  const job = {
    sourceType: "payment",
    sourceId: paymentValues.externalPaymentId,
    operation: "fulfill",
    idempotencyKey: `fulfill:${crypto.randomUUID()}`,
  } as const;
  await database.db.insert(fulfillmentJobs).values(job);
  await expect(database.db.insert(fulfillmentJobs).values(job)).rejects.toThrow();
});

it("forbids raw retention on invalid signatures", async () => {
  await expect(
    database.db.insert(paymentWebhookInbox).values({
      environment: "test",
      providerEventId: `invalid-${crypto.randomUUID()}`,
      dedupHash: crypto.randomUUID().replaceAll("-", ""),
      eventType: "invalid_signature",
      signatureValid: false,
      normalizedPayloadJson: {},
      payloadHash: "c".repeat(64),
      payloadSizeBytes: 20,
      rawPayloadCiphertext: new Uint8Array([1, 2, 3]),
      rawPayloadKeyId: "test-key",
      rawPayloadExpiresAt: new Date(Date.now() + 1000),
      retentionClass: "invalid_signature",
    }),
  ).rejects.toThrow();
});
