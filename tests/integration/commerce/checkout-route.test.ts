import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createProductCatalog } from "@/platform/commerce/application/product-catalog";
import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import { ensureCommerceProduct } from "@/platform/commerce/application/sync-product-catalog";
import { createDatabaseClient } from "@/platform/database/client";
import { accountSubjects, commerceReconciliationRuns, orders } from "@/platform/database/schema";

const routeDependencies = vi.hoisted(() => ({
  getAccountContext: vi.fn(),
  getCommerceRuntime: vi.fn(),
}));

vi.mock("@/platform/auth/account-context", () => ({
  getAccountContext: routeDependencies.getAccountContext,
}));
vi.mock("@/platform/commerce/commerce-runtime", () => ({
  getCommerceRuntime: routeDependencies.getCommerceRuntime,
}));
vi.mock("@/platform/config/env", () => ({
  env: { appOrigin: "https://app.example.com" },
}));
vi.mock("@/config/features.config", () => ({
  featuresConfig: {
    commerce: { enabled: true, oneTime: true, subscriptions: true, credits: false },
  },
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

const catalog = createProductCatalog([
  {
    key: "route-one-time-test",
    version: 1,
    enabled: true,
    commercialModel: "one_time",
    currency: "USD",
    expectedPrice: "29.00",
    providerProductIdByEnvironment: { test: "PROD_route_test" },
    fulfillmentKey: "test-delivery",
    refundPolicyKey: "default-one-time",
  },
]);

it("returns a permanent conflict for a provider-created checkout requiring operator review", async () => {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const product = await ensureCommerceProduct(
    database.db,
    catalog.getEnabled("route-one-time-test", "test"),
    "test",
  );
  const idempotencyKey = `checkout:${crypto.randomUUID()}`;
  const [order] = await database.db
    .insert(orders)
    .values({
      subjectId: subject.id,
      productId: product.id,
      environment: "test",
      expectedCurrency: "USD",
      expectedMinor: 2900n,
      checkoutIdempotencyKey: idempotencyKey,
      checkoutState: "failed",
      externalCheckoutSessionId: "session-operator-review",
      externalOrderId: "order-operator-review",
    })
    .returning();
  if (!order) throw new Error("order insert failed");
  await database.db.insert(commerceReconciliationRuns).values({
    targetType: "checkout_session",
    targetId: "session-operator-review",
    actorType: "application",
    beforeJson: { orderId: order.id, checkoutState: "creating" },
    afterJson: {
      externalCheckoutSessionId: "session-operator-review",
      externalOrderId: "order-operator-review",
      checkoutUrlReturned: false,
      localCheckoutState: "failed",
      orderIdentifiersPersisted: true,
    },
    result: "operator_review_required",
  });

  let providerCalls = 0;
  const provider = {
    name: "route-test-provider",
    capabilities: { oneTime: true, subscriptions: false, partialRefunds: false },
    async createCheckout() {
      providerCalls += 1;
      throw new Error("provider must not be called");
    },
  } as unknown as PaymentProvider;
  routeDependencies.getCommerceRuntime.mockResolvedValue({
    database: database.db,
    catalog,
    provider,
    environment: "test",
  });
  routeDependencies.getAccountContext.mockResolvedValue({
    subject,
    user: { email: "operator-review@example.com" },
  });
  const { POST } = await import("@/app/api/commerce/checkout/route");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await POST(
      new Request("https://app.example.com/api/commerce/checkout", {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ productKey: "route-one-time-test" }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "checkout_conflict" });
  }

  expect(providerCalls).toBe(0);
  const [retainedOrder] = await database.db.select().from(orders).where(eq(orders.id, order.id));
  expect(retainedOrder).toMatchObject({
    checkoutState: "failed",
    checkoutLeaseToken: null,
    checkoutLeaseExpiresAt: null,
    externalCheckoutSessionId: "session-operator-review",
    externalOrderId: "order-operator-review",
  });
  const reconciliations = await database.db
    .select()
    .from(commerceReconciliationRuns)
    .where(eq(commerceReconciliationRuns.targetId, "session-operator-review"));
  expect(reconciliations).toHaveLength(1);
});
