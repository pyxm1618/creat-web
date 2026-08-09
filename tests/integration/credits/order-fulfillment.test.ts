import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createCreditOrderFulfillment } from "@/platform/credits/integration/commerce/credit-fulfillment";
import { getCreditBalance } from "@/platform/credits/application/credit-service";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceProducts,
  creditGrants,
  orders,
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

async function paidOrder(environment: "test" | "production", externalPaymentId: string) {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `credits-${crypto.randomUUID()}`,
      version: 1,
      model: "one_time",
      environment,
      providerProductId: `PROD_${crypto.randomUUID().replaceAll("-", "").slice(0, 22)}`,
      currency: "USD",
      expectedMinor: 900n,
      fulfillmentKey: "credit-pack",
      refundPolicyKey: "default",
    })
    .returning();
  if (!product) throw new Error("product insert failed");
  const [order] = await database.db
    .insert(orders)
    .values({
      subjectId: subject.id,
      productId: product.id,
      environment,
      status: "paid",
      expectedCurrency: "USD",
      expectedMinor: 900n,
      checkoutIdempotencyKey: `checkout:${crypto.randomUUID()}`,
      checkoutState: "created",
      externalOrderId: `ORD_${crypto.randomUUID()}`,
      paidAt: new Date("2026-08-08T10:00:00Z"),
    })
    .returning();
  if (!order) throw new Error("order insert failed");
  await database.db.insert(payments).values({
    orderId: order.id,
    environment,
    externalPaymentId,
    status: "succeeded",
    refundStatus: "none",
    currency: "USD",
    amountMinor: 900n,
    rawPayloadHash: "a".repeat(64),
  });
  return { subject, order };
}

it("grants paid-order credits exactly once", async () => {
  const externalPaymentId = `PAY_${crypto.randomUUID()}`;
  const { subject, order } = await paidOrder("test", externalPaymentId);
  const fulfill = createCreditOrderFulfillment(database.db, {
    fulfillmentKey: "credit-pack",
    creditType: "reading",
    quantity: 3,
  });
  const input = {
    sourceType: "payment",
    sourceId: externalPaymentId,
    operation: "fulfill:credit-pack",
    operationKey: `payment:test:${externalPaymentId}:fulfill:credit-pack`,
  } as const;

  await fulfill(input);
  await fulfill(input);

  expect(
    await getCreditBalance(database.db, { subjectId: subject.id, creditType: "reading" }),
  ).toMatchObject({
    available: 3,
  });
  const grants = await database.db
    .select()
    .from(creditGrants)
    .where(and(eq(creditGrants.sourceType, "order"), eq(creditGrants.sourceId, order.id)));
  expect(grants).toHaveLength(1);
});

it("fails closed when the external payment id is ambiguous across environments", async () => {
  const externalPaymentId = `PAY_${crypto.randomUUID()}`;
  await paidOrder("test", externalPaymentId);
  await paidOrder("production", externalPaymentId);
  const fulfill = createCreditOrderFulfillment(database.db, {
    fulfillmentKey: "credit-pack",
    creditType: "reading",
    quantity: 3,
  });

  await expect(
    fulfill({
      sourceType: "payment",
      sourceId: externalPaymentId,
      operation: "fulfill:credit-pack",
      operationKey: `payment:test:${externalPaymentId}:fulfill:credit-pack`,
    }),
  ).rejects.toThrow("missing or ambiguous");
});
