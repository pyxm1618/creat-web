import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { InvalidWebhookSignatureError } from "@/platform/commerce/application/errors";
import { parseNormalizedProviderEvent } from "@/platform/commerce/application/event-json";
import { ingestProviderWebhook } from "@/platform/commerce/application/ingest-provider-webhook";
import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import { processOneTimePaymentEvent } from "@/platform/commerce/application/process-one-time-payment-event";
import { processProviderEvent } from "@/platform/commerce/application/process-provider-event";
import { purgeExpiredWebhookPayloads } from "@/platform/commerce/application/purge-webhook-payloads";
import { payloadHash } from "@/platform/commerce/application/webhook-retention";
import type { NormalizedProviderEvent } from "@/platform/commerce/domain/events";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceProducts,
  fulfillmentJobs,
  orders,
  payments,
  paymentWebhookInbox,
} from "@/platform/database/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabaseClient(databaseUrl);
const retentionKey = Buffer.alloc(32, 9).toString("base64");

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

function provider(result: NormalizedProviderEvent | Error): PaymentProvider {
  return {
    name: "test-provider",
    capabilities: { oneTime: true, subscriptions: false, partialRefunds: false },
    async createCheckout() {
      throw new Error("not used");
    },
    async createOneTimeCheckout() {
      throw new Error("not used");
    },
    async cancelSubscription() {
      throw new Error("not used");
    },
    async resumeSubscription() {
      throw new Error("not used");
    },
    async requestRefund() {
      throw new Error("not used");
    },
    async getPayment() {
      return null;
    },
    async verifyAndNormalizeWebhook() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

async function seedOrder() {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `product-${crypto.randomUUID()}`,
      version: 1,
      model: "one_time",
      billingInterval: null,
      environment: "test",
      providerProductId: `PROD_${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor: 2900n,
      fulfillmentKey: "test-delivery",
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
      expectedMinor: 2900n,
      checkoutIdempotencyKey: `checkout:${crypto.randomUUID()}`,
      checkoutState: "created",
      externalCheckoutSessionId: `session-${crypto.randomUUID()}`,
    })
    .returning();
  if (!order) throw new Error("order insert failed");
  return { subject, product, order };
}

it("stores no raw body for an invalid signature", async () => {
  const raw = new TextEncoder().encode('{"secret":"must-not-be-retained"}');
  const result = await ingestProviderWebhook({
    database: database.db,
    provider: provider(new InvalidWebhookSignatureError()),
    environment: "test",
    rawBody: raw,
    signature: "bad",
    retention: { encryptionKeyBase64: retentionKey, keyId: "test-key" },
  });
  expect(result.accepted).toBe(false);
  const row = await database.db.query.paymentWebhookInbox.findFirst({
    where: eq(paymentWebhookInbox.dedupHash, payloadHash(raw)),
  });
  expect(row).toMatchObject({ signatureValid: false, retentionClass: "invalid_signature" });
  expect(row?.rawPayloadCiphertext).toBeNull();
  expect(row?.rawPayloadKeyId).toBeNull();
});

it("binds provider order to merchant reference and creates one payment and fulfillment job", async () => {
  const { order } = await seedOrder();
  const event: NormalizedProviderEvent = {
    type: "one_time_payment_succeeded",
    eventId: `delivery-${crypto.randomUUID()}`,
    environment: "test",
    externalOrderId: `ORD_${crypto.randomUUID()}`,
    merchantOrderReference: order.id,
    externalPaymentId: `PAY_${crypto.randomUUID()}`,
    amount: { currency: "USD", minor: 2900n },
    occurredAt: new Date("2026-08-08T04:00:00Z"),
  };

  await processProviderEvent(database.db, event, "a".repeat(64));
  await processProviderEvent(database.db, event, "b".repeat(64));

  const storedOrder = await database.db.query.orders.findFirst({ where: eq(orders.id, order.id) });
  expect(storedOrder).toMatchObject({ status: "paid", externalOrderId: event.externalOrderId });
  const paymentRows = await database.db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.environment, "test"),
        eq(payments.externalPaymentId, event.externalPaymentId),
      ),
    );
  expect(paymentRows).toHaveLength(1);
  const jobs = await database.db
    .select()
    .from(fulfillmentJobs)
    .where(eq(fulfillmentJobs.sourceId, event.externalPaymentId));
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.operation).toBe("fulfill:test-delivery");
});

it("keeps one-time payment application available as an explicit transaction handler", async () => {
  const { order } = await seedOrder();
  const event: NormalizedProviderEvent = {
    type: "one_time_payment_succeeded",
    eventId: `handler-${crypto.randomUUID()}`,
    environment: "test",
    externalOrderId: `ORD_${crypto.randomUUID()}`,
    merchantOrderReference: order.id,
    externalPaymentId: `PAY_${crypto.randomUUID()}`,
    amount: { currency: "USD", minor: 2900n },
    occurredAt: new Date("2026-08-08T04:00:00Z"),
  };

  await database.db.transaction((tx) => processOneTimePaymentEvent(tx, event, "a".repeat(64)));

  const storedOrder = await database.db.query.orders.findFirst({ where: eq(orders.id, order.id) });
  expect(storedOrder).toMatchObject({ status: "paid", externalOrderId: event.externalOrderId });
});

it("prevents cumulative refunds from exceeding the captured payment", async () => {
  const { order } = await seedOrder();
  const paymentId = `PAY_${crypto.randomUUID()}`;
  await processProviderEvent(
    database.db,
    {
      type: "one_time_payment_succeeded",
      eventId: `delivery-${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: `ORD_${crypto.randomUUID()}`,
      merchantOrderReference: order.id,
      externalPaymentId: paymentId,
      amount: { currency: "USD", minor: 2900n },
      occurredAt: new Date("2026-08-08T04:00:00Z"),
    },
    "c".repeat(64),
  );

  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `refund-${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: paymentId,
      amount: { currency: "USD", minor: 1000n },
      occurredAt: new Date("2026-08-08T05:00:00Z"),
    },
    "d".repeat(64),
  );
  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `refund-${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: paymentId,
      amount: { currency: "USD", minor: 1900n },
      occurredAt: new Date("2026-08-08T06:00:00Z"),
    },
    "e".repeat(64),
  );
  await expect(
    processProviderEvent(
      database.db,
      {
        type: "refund_succeeded",
        eventId: `refund-${crypto.randomUUID()}`,
        environment: "test",
        externalPaymentId: paymentId,
        amount: { currency: "USD", minor: 1n },
        occurredAt: new Date("2026-08-08T07:00:00Z"),
      },
      "f".repeat(64),
    ),
  ).rejects.toThrow("refund exceeds captured payment");

  const payment = await database.db.query.payments.findFirst({
    where: and(eq(payments.environment, "test"), eq(payments.externalPaymentId, paymentId)),
  });
  expect(payment).toMatchObject({ refundedMinor: 2900n, refundStatus: "refunded" });
});

it("encrypts unsupported signed events and purges expired ciphertext", async () => {
  const now = new Date("2026-08-08T00:00:00Z");
  const raw = new TextEncoder().encode('{"signed":"unsupported"}');
  const event: NormalizedProviderEvent = {
    type: "unsupported_signed_event",
    eventId: `delivery-${crypto.randomUUID()}`,
    environment: "test",
    providerType: "subscription.activated",
    occurredAt: now,
  };
  await ingestProviderWebhook({
    database: database.db,
    provider: provider(event),
    environment: "test",
    rawBody: raw,
    signature: "valid-by-fixture",
    retention: { encryptionKeyBase64: retentionKey, keyId: "test-key" },
    now,
  });

  const before = await database.db.query.paymentWebhookInbox.findFirst({
    where: eq(paymentWebhookInbox.providerEventId, event.eventId),
  });
  expect(before?.rawPayloadCiphertext).not.toBeNull();
  expect(before?.rawPayloadExpiresAt).toEqual(new Date("2026-09-07T00:00:00Z"));

  expect(
    await purgeExpiredWebhookPayloads(database.db, { now: new Date("2026-09-08T00:00:00Z") }),
  ).toBeGreaterThanOrEqual(1);
  const after = await database.db.query.paymentWebhookInbox.findFirst({
    where: eq(paymentWebhookInbox.providerEventId, event.eventId),
  });
  expect(after?.rawPayloadCiphertext).toBeNull();
  expect(after?.rawPayloadPurgedAt).toEqual(new Date("2026-09-08T00:00:00Z"));
});

it("stores a JSON-safe lossless subscription event for deferred inbox processing", async () => {
  const event: NormalizedProviderEvent = {
    type: "subscription_payment_succeeded",
    eventId: `subscription-${crypto.randomUUID()}`,
    environment: "test",
    externalOrderId: `SUB_${crypto.randomUUID()}`,
    merchantOrderReference: crypto.randomUUID(),
    externalPaymentId: `PAY_${crypto.randomUUID()}`,
    amount: { currency: "USD", minor: 2900n },
    occurredAt: new Date("2026-08-10T01:02:03.000Z"),
    currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
    merchantId: "MER_test",
    storeId: "STO_test",
  };

  await ingestProviderWebhook({
    database: database.db,
    provider: provider(event),
    environment: "test",
    rawBody: new TextEncoder().encode('{"signed":"subscription"}'),
    signature: "valid-by-fixture",
    retention: {},
  });

  const row = await database.db.query.paymentWebhookInbox.findFirst({
    where: eq(paymentWebhookInbox.providerEventId, event.eventId),
  });
  expect(row?.normalizedPayloadJson).toMatchObject({ version: 1, type: event.type });
  expect(parseNormalizedProviderEvent(row?.normalizedPayloadJson)).toEqual(event);
});
