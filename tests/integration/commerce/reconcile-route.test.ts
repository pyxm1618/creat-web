import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceAppliedEvents,
  commerceProducts,
  commerceReconciliationRuns,
  fulfillmentJobs,
  orders,
  paymentReconciliationJobs,
  payments,
} from "@/platform/database/schema";

const routeState = vi.hoisted(() => ({
  runtime: null as unknown,
  runtimeCalls: 0,
  creditsEnabled: false,
  refundResult: 0,
  refundCalls: 0,
  purgeCalls: 0,
  creditCalls: 0,
  alertsEmitted: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/config/features.config", () => ({
  featuresConfig: {
    commerce: {
      enabled: true,
      get credits() {
        return routeState.creditsEnabled;
      },
    },
  },
}));
vi.mock("@/platform/config/env", () => ({
  env: { cronSecret: "route-secret", waffoStoreId: "STORE_ROUTE" },
}));
vi.mock("@/platform/database/application-database", () => ({ db: {} }));
vi.mock("@/platform/commerce/commerce-runtime", () => ({
  getCommerceRuntime: async () => {
    routeState.runtimeCalls += 1;
    return routeState.runtime;
  },
}));
vi.mock("@/platform/commerce/application/reconcile-stale-refunds", () => ({
  reconcileStaleRefunds: async () => {
    routeState.refundCalls += 1;
    return routeState.refundResult;
  },
}));
vi.mock("@/platform/commerce/application/purge-webhook-payloads", () => ({
  purgeExpiredWebhookPayloads: async () => {
    routeState.purgeCalls += 1;
    return 0;
  },
}));
vi.mock("@/platform/commerce/application/webhook-retention-metrics", () => ({
  getWebhookRetentionMetrics: async () => ({
    retainedPayloads: 0,
    oldestRetainedPayloadAgeSeconds: 0,
  }),
}));
vi.mock("@/platform/credits/application/reconcile-credit-ledger", () => ({
  reconcileCreditLedgerBatch: async () => {
    routeState.creditCalls += 1;
    return { processed: 0, issues: [], cycleComplete: true };
  },
}));
vi.mock("@/platform/observability/operational-snapshot", () => ({
  collectOperationalAlertSnapshot: async () => ({
    deadLettersCreated: 0,
    magicLinkRequests5m: 0,
    invalidWebhookSignatures5m: 0,
    reconciliationMismatches: 0,
    jobBacklog: 0,
    oldestJobAgeSeconds: 0,
    providerFailures5m: 0,
  }),
}));
vi.mock("@/platform/observability/metrics", () => ({ emitMetric: () => undefined }));
vi.mock("@/platform/observability/alerts", () => ({
  evaluateOperationalAlerts: () => [],
  emitOperationalAlerts: () => {
    routeState.alertsEmitted += 1;
  },
}));

import { GET } from "@/app/api/internal/jobs/reconcile/route";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabaseClient(databaseUrl);

function paymentProvider(getPayment: PaymentProvider["getPayment"]): PaymentProvider {
  const unsupported = async () => {
    throw new Error("unexpected provider operation");
  };
  return {
    name: "reconcile-route-test-provider",
    capabilities: { oneTime: true, subscriptions: true, partialRefunds: true },
    createCheckout: unsupported,
    createOneTimeCheckout: unsupported,
    cancelSubscription: unsupported,
    resumeSubscription: unsupported,
    requestRefund: unsupported,
    getPayment,
    verifyAndNormalizeWebhook: unsupported,
  };
}

async function seedStaleOrder() {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `reconcile-route-${crypto.randomUUID()}`,
      version: 1,
      model: "one_time",
      environment: "test",
      providerProductId: `PROD_${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor: 2900n,
      fulfillmentKey: "reconcile-route",
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
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
    })
    .returning();
  if (!order?.externalOrderId) throw new Error("order insert failed");
  return order;
}

function authorizedRequest() {
  return new Request("https://example.test/api/internal/jobs/reconcile", {
    headers: { authorization: "Bearer route-secret" },
  });
}

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
  await database.db.delete(commerceReconciliationRuns);
  await database.db.delete(paymentReconciliationJobs);
  await database.db.delete(fulfillmentJobs);
  await database.db.delete(commerceAppliedEvents);
  await database.db.delete(payments);
  await database.db.delete(orders);
  await database.db.delete(commerceProducts);
  await database.db.delete(accountSubjects);
  routeState.runtime = null;
  routeState.runtimeCalls = 0;
  routeState.creditsEnabled = false;
  routeState.refundResult = 0;
  routeState.refundCalls = 0;
  routeState.purgeCalls = 0;
  routeState.creditCalls = 0;
  routeState.alertsEmitted = 0;
});

it("does not reach Commerce runtime or provider when authentication fails", async () => {
  let providerCalls = 0;
  routeState.runtime = {
    database: database.db,
    provider: paymentProvider(async () => {
      providerCalls += 1;
      return { payments: [], warnings: [] };
    }),
    environment: "test",
  };

  const response = await GET(new Request("https://example.test/api/internal/jobs/reconcile"));

  expect(response.status).toBe(401);
  expect(routeState.runtimeCalls).toBe(0);
  expect(providerCalls).toBe(0);
  expect(routeState.refundCalls).toBe(0);
  expect(routeState.purgeCalls).toBe(0);
  expect(routeState.alertsEmitted).toBe(0);
});

it("does not start provider or maintenance work when Commerce is disabled", async () => {
  routeState.runtime = null;

  const response = await GET(authorizedRequest());

  expect(response.status).toBe(404);
  expect(routeState.runtimeCalls).toBe(1);
  expect(routeState.refundCalls).toBe(0);
  expect(routeState.purgeCalls).toBe(0);
  expect(routeState.alertsEmitted).toBe(0);
});

it("runs payment reconciliation with exact counters even when refunds consume all 50 items", async () => {
  const order = await seedStaleOrder();
  let providerCalls = 0;
  const provider = paymentProvider(async (input) => {
    providerCalls += 1;
    expect(input).toMatchObject({
      environment: "test",
      merchantOrderReference: order.id,
      externalOrderId: order.externalOrderId,
    });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    return {
      payments: [
        {
          environment: "test",
          model: "one_time",
          storeId: "STORE_ROUTE",
          externalOrderId: order.externalOrderId!,
          merchantOrderReference: order.id,
          externalPaymentId: "PAY_ROUTE_APPLIED",
          status: "succeeded",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2026-08-10T00:05:00.000Z"),
        },
      ],
      warnings: [],
    };
  });
  routeState.runtime = {
    database: database.db,
    provider,
    environment: "test",
  };
  routeState.refundResult = 50;

  const response = await GET(authorizedRequest());

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    staleRefundsReconciled: 50,
    paymentScanned: 1,
    paymentApplied: 1,
    paymentRetried: 0,
    paymentOperatorReview: 0,
  });
  expect(providerCalls).toBe(1);
  expect(routeState.refundCalls).toBe(1);
  expect(routeState.alertsEmitted).toBe(1);
});

it("caps the independent payment opportunity at five stale orders", async () => {
  const staleOrders = [];
  for (let index = 0; index < 6; index += 1) staleOrders.push(await seedStaleOrder());
  const ordersById = new Map(staleOrders.map((order) => [order.id, order]));
  const providerOrderIds = new Set<string>();
  const provider = paymentProvider(async (input) => {
    if (!input.merchantOrderReference) throw new Error("merchant order reference missing");
    const order = ordersById.get(input.merchantOrderReference);
    if (!order?.externalOrderId) throw new Error("provider received an unexpected order");
    providerOrderIds.add(order.id);
    return {
      payments: [
        {
          environment: "test",
          model: "one_time",
          storeId: "STORE_ROUTE",
          externalOrderId: order.externalOrderId,
          merchantOrderReference: order.id,
          externalPaymentId: `PAY_ROUTE_${order.id}`,
          status: "canceled",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2026-08-10T00:05:00.000Z"),
        },
      ],
      warnings: [],
    };
  });
  routeState.runtime = {
    database: database.db,
    provider,
    environment: "test",
  };
  routeState.refundResult = 50;

  const response = await GET(authorizedRequest());

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    paymentScanned: 5,
    paymentApplied: 5,
    paymentRetried: 0,
    paymentOperatorReview: 0,
    staleRefundsReconciled: 50,
  });
  expect(providerOrderIds.size).toBe(5);
  expect(await database.db.select().from(paymentReconciliationJobs)).toHaveLength(5);
});

it("returns exact nonzero applied, retried, and operator-review payment counters", async () => {
  const appliedOrder = await seedStaleOrder();
  const retryOrder = await seedStaleOrder();
  const reviewOrder = await seedStaleOrder();
  const ordersById = new Map(
    [appliedOrder, retryOrder, reviewOrder].map((order) => [order.id, order]),
  );
  const provider = paymentProvider(async (input) => {
    if (!input.merchantOrderReference) throw new Error("merchant order reference missing");
    const order = ordersById.get(input.merchantOrderReference);
    if (!order?.externalOrderId) throw new Error("provider received an unexpected order");
    if (order.id === retryOrder.id) return { payments: [], warnings: [] };
    return {
      payments: [
        {
          environment: "test",
          model: order.id === reviewOrder.id ? "subscription" : "one_time",
          storeId: "STORE_ROUTE",
          externalOrderId: order.externalOrderId,
          merchantOrderReference: order.id,
          externalPaymentId: `PAY_ROUTE_${order.id}`,
          status: "succeeded",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2026-08-10T00:05:00.000Z"),
        },
      ],
      warnings: [],
    };
  });
  routeState.runtime = {
    database: database.db,
    provider,
    environment: "test",
  };

  const response = await GET(authorizedRequest());

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    paymentScanned: 3,
    paymentApplied: 1,
    paymentRetried: 1,
    paymentOperatorReview: 1,
  });
});

it("continues refund, purge, and alert maintenance after the payment slice aborts", async () => {
  await seedStaleOrder();
  let providerSawSignal = false;
  let providerSettledAfterAbort = false;
  const provider = paymentProvider(
    async (input) =>
      new Promise((_resolve, reject) => {
        if (!input.signal) throw new Error("payment lookup signal missing");
        providerSawSignal = true;
        input.signal.addEventListener(
          "abort",
          () => {
            providerSettledAfterAbort = true;
            reject(new DOMException("payment slice expired", "AbortError"));
          },
          { once: true },
        );
      }),
  );
  routeState.runtime = {
    database: database.db,
    provider,
    environment: "test",
  };
  routeState.refundResult = 1;
  routeState.creditsEnabled = true;

  const response = await GET(authorizedRequest());
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    paymentScanned: 0,
    paymentApplied: 0,
    paymentRetried: 0,
    paymentOperatorReview: 0,
    staleRefundsReconciled: 1,
    purgedPayloads: 0,
    alertsEvaluated: true,
  });
  expect(providerSawSignal).toBe(true);
  expect(providerSettledAfterAbort).toBe(true);
  expect(routeState.refundCalls).toBe(1);
  expect(routeState.purgeCalls).toBe(1);
  expect(routeState.creditCalls).toBe(1);
  expect(routeState.alertsEmitted).toBe(1);
  expect(await database.db.select().from(payments)).toHaveLength(0);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
  expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
    { state: "processing", attempts: 0 },
  ]);
}, 10_000);
