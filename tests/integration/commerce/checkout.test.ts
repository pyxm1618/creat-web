import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createCheckout } from "@/platform/commerce/application/create-checkout";
import { createProductCatalog } from "@/platform/commerce/application/product-catalog";
import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import { createDatabaseClient } from "@/platform/database/client";
import { accountSubjects, orders } from "@/platform/database/schema";

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
    key: "one-time-test",
    version: 1,
    enabled: true,
    commercialModel: "one_time",
    currency: "USD",
    expectedPrice: "29.00",
    providerProductIdByEnvironment: { test: "PROD_test" },
    fulfillmentKey: "test-delivery",
    refundPolicyKey: "default-one-time",
  },
]);

async function subjectId(): Promise<string> {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  return subject.id;
}

function provider(create: PaymentProvider["createOneTimeCheckout"]): PaymentProvider {
  return {
    name: "waffo",
    createOneTimeCheckout: create,
    async getPayment() {
      return null;
    },
    async verifyAndNormalizeWebhook() {
      throw new Error("not used");
    },
  };
}

it("allows only one concurrent caller to create the provider checkout", async () => {
  const subject = await subjectId();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = provider(async () => {
    calls += 1;
    await gate;
    return {
      externalCheckoutSessionId: "session-1",
      checkoutUrl: "https://checkout.example/session-1",
    };
  });
  const input = {
    subjectId: subject,
    buyerIdentity: subject,
    productKey: "one-time-test",
    environment: "test" as const,
    idempotencyKey: `checkout:${crypto.randomUUID()}`,
    appOrigin: "https://app.example.com",
  };

  const first = createCheckout(input, { database: database.db, catalog, provider: fake });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await expect(
    createCheckout(input, { database: database.db, catalog, provider: fake }),
  ).rejects.toThrow("checkout initialization in progress");
  release();
  await expect(first).resolves.toMatchObject({ checkoutUrl: "https://checkout.example/session-1" });

  expect(calls).toBe(1);
  const rows = await database.db
    .select()
    .from(orders)
    .where(eq(orders.checkoutIdempotencyKey, input.idempotencyKey));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.checkoutState).toBe("created");
});

it("reuses the local order after provider failure without creating a duplicate row", async () => {
  const subject = await subjectId();
  let calls = 0;
  const fake = provider(async () => {
    calls += 1;
    if (calls === 1) throw new Error("provider unavailable");
    return {
      externalCheckoutSessionId: "session-retry",
      checkoutUrl: "https://checkout.example/session-retry",
    };
  });
  const input = {
    subjectId: subject,
    buyerIdentity: subject,
    productKey: "one-time-test",
    environment: "test" as const,
    idempotencyKey: `checkout:${crypto.randomUUID()}`,
    appOrigin: "https://app.example.com",
  };

  await expect(createCheckout(input, { database: database.db, catalog, provider: fake })).rejects.toThrow(
    "provider unavailable",
  );
  const retried = await createCheckout(input, { database: database.db, catalog, provider: fake });
  expect(retried.reused).toBe(true);
  expect(calls).toBe(2);

  const rows = await database.db
    .select()
    .from(orders)
    .where(eq(orders.checkoutIdempotencyKey, input.idempotencyKey));
  expect(rows).toHaveLength(1);
});
