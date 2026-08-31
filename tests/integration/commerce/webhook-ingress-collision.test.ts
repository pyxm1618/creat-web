import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { ingestProviderWebhook } from "@/platform/commerce/application/ingest-provider-webhook";
import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import type { NormalizedProviderEvent } from "@/platform/commerce/domain/events";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceAppliedEvents,
  commerceProducts,
  commerceReconciliationRuns,
  fulfillmentJobs,
  orders,
  payments,
  paymentWebhookInbox,
} from "@/platform/database/schema";

const routeDependencies = vi.hoisted(() => ({ getCommerceRuntime: vi.fn() }));

vi.mock("@/platform/commerce/commerce-runtime", () => ({
  getCommerceRuntime: routeDependencies.getCommerceRuntime,
}));

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

beforeEach(async () => {
  routeDependencies.getCommerceRuntime.mockReset();
  await database.db.delete(commerceReconciliationRuns);
  await database.db.delete(paymentWebhookInbox);
  await database.db.delete(fulfillmentJobs);
  await database.db.delete(commerceAppliedEvents);
  await database.db.delete(payments);
  await database.db.delete(orders);
  await database.db.delete(commerceProducts);
  await database.db.delete(accountSubjects);
});

function provider(normalize: (rawBody: Uint8Array) => NormalizedProviderEvent): PaymentProvider {
  const unsupported = async () => {
    throw new Error("unexpected provider operation");
  };
  return {
    name: "webhook-ingress-collision-provider",
    capabilities: { oneTime: true, subscriptions: false, partialRefunds: false },
    createCheckout: unsupported,
    createOneTimeCheckout: unsupported,
    cancelSubscription: unsupported,
    resumeSubscription: unsupported,
    requestRefund: unsupported,
    async getPayment() {
      return { payments: [], warnings: [] };
    },
    async verifyAndNormalizeWebhook(input) {
      return normalize(input.rawBody);
    },
  };
}

async function seedOrder() {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `webhook-ingress-collision-${crypto.randomUUID()}`,
      version: 1,
      model: "one_time",
      environment: "test",
      providerProductId: `PROD_${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor: 2900n,
      fulfillmentKey: "webhook-ingress-collision",
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
      externalOrderId: `ORD_${crypto.randomUUID()}`,
    })
    .returning();
  if (!order) throw new Error("order insert failed");
  return order;
}

it("distinguishes an exact signed replay from the same event id with a different raw hash", async () => {
  const event: NormalizedProviderEvent = {
    type: "one_time_payment_failed",
    eventId: `EVT_${crypto.randomUUID()}`,
    environment: "test",
    externalOrderId: `ORD_${crypto.randomUUID()}`,
    merchantOrderReference: crypto.randomUUID(),
    externalPaymentId: `PAY_${crypto.randomUUID()}`,
    occurredAt: new Date("2030-05-02T00:00:00.000Z"),
    storeId: "STORE_TEST",
  };
  const webhookProvider = provider(() => event);
  const firstRaw = new TextEncoder().encode('{"attempt":1}');
  const conflictingRaw = new TextEncoder().encode('{"attempt":2}');

  const first = await ingestProviderWebhook({
    database: database.db,
    provider: webhookProvider,
    environment: "test",
    rawBody: firstRaw,
    signature: "valid",
    retention: {},
  });
  const exactReplay = await ingestProviderWebhook({
    database: database.db,
    provider: webhookProvider,
    environment: "test",
    rawBody: firstRaw,
    signature: "valid",
    retention: {},
  });
  const collision = await ingestProviderWebhook({
    database: database.db,
    provider: webhookProvider,
    environment: "test",
    rawBody: conflictingRaw,
    signature: "valid",
    retention: {},
  });
  const repeatedCollision = await ingestProviderWebhook({
    database: database.db,
    provider: webhookProvider,
    environment: "test",
    rawBody: conflictingRaw,
    signature: "valid",
    retention: {},
  });

  expect(first).toMatchObject({ accepted: true, duplicate: false });
  expect(exactReplay).toMatchObject({ accepted: true, duplicate: true });
  expect(collision).toMatchObject({ accepted: true, duplicate: false, operatorReview: true });
  expect(repeatedCollision).toMatchObject({
    accepted: true,
    duplicate: false,
    operatorReview: true,
  });
  expect(await database.db.select().from(paymentWebhookInbox)).toMatchObject([
    {
      providerEventId: event.eventId,
      eventType: event.type,
      state: "pending",
      lastErrorCode: null,
    },
  ]);
  expect(await database.db.select().from(commerceReconciliationRuns)).toMatchObject([
    {
      targetType: "provider_event_identity",
      targetId: event.eventId,
      result: "operator_review_required",
    },
  ]);
});

it("returns an explicit 202 operator-review ack for a signed event type collision", async () => {
  const order = await seedOrder();
  const eventId = `EVT_${crypto.randomUUID()}`;
  const failedEvent: NormalizedProviderEvent = {
    type: "one_time_payment_failed",
    eventId,
    environment: "test",
    externalOrderId: order.externalOrderId!,
    merchantOrderReference: order.id,
    externalPaymentId: `PAY_${crypto.randomUUID()}`,
    occurredAt: new Date("2030-05-02T00:00:00.000Z"),
    storeId: "STORE_TEST",
  };
  const succeededEvent: NormalizedProviderEvent = {
    type: "one_time_payment_succeeded",
    eventId,
    environment: "test",
    externalOrderId: order.externalOrderId!,
    merchantOrderReference: order.id,
    externalPaymentId: `PAY_${crypto.randomUUID()}`,
    amount: { currency: "USD", minor: 2900n },
    occurredAt: new Date("2030-05-02T00:00:01.000Z"),
    storeId: "STORE_TEST",
  };
  const failedRaw = '{"type":"failed"}';
  const succeededRaw = '{"type":"succeeded"}';
  const webhookProvider = provider((rawBody) =>
    new TextDecoder().decode(rawBody) === failedRaw ? failedEvent : succeededEvent,
  );
  routeDependencies.getCommerceRuntime.mockResolvedValue({
    database: database.db,
    provider: webhookProvider,
    environment: "test",
    retention: {},
    fulfillment: {
      async fulfill() {
        throw new Error("collision must not attempt fulfillment");
      },
    },
  });
  const { POST } = await import("@/app/api/webhooks/waffo/route");
  const request = (body: string) =>
    new Request("https://app.example.com/api/webhooks/waffo", {
      method: "POST",
      headers: { "x-waffo-signature": "valid" },
      body,
    });

  const accepted = await POST(request(failedRaw));
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ accepted: true });
  const duplicate = await POST(request(failedRaw));
  expect(duplicate.status).toBe(202);
  expect(await duplicate.json()).toEqual({ accepted: true, duplicate: true });
  const collision = await POST(request(succeededRaw));
  expect(collision.status).toBe(202);
  expect(await collision.json()).toEqual({ accepted: true, operatorReview: true });
  const repeatedCollision = await POST(request(succeededRaw));
  expect(repeatedCollision.status).toBe(202);
  expect(await repeatedCollision.json()).toEqual({ accepted: true, operatorReview: true });

  expect(await database.db.select().from(payments)).toHaveLength(0);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
  expect(
    await database.db.query.orders.findFirst({ where: eq(orders.id, order.id) }),
  ).toMatchObject({
    status: "pending",
  });
  expect(await database.db.select().from(commerceAppliedEvents)).toMatchObject([
    { providerEventId: eventId, eventType: "one_time_payment_failed" },
  ]);
  expect(await database.db.select().from(commerceReconciliationRuns)).toMatchObject([
    {
      targetType: "provider_event_identity",
      targetId: eventId,
      result: "operator_review_required",
    },
  ]);
  expect(await database.db.select().from(paymentWebhookInbox)).toMatchObject([
    {
      providerEventId: eventId,
      eventType: "one_time_payment_failed",
      state: "completed",
      lastErrorCode: null,
    },
  ]);
});
