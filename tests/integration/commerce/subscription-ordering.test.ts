import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { processProviderEvent } from "@/platform/commerce/application/process-provider-event";
import { createDatabaseClient } from "@/platform/database/client";
import { accountSubjects, commerceProducts, orders, subscriptions } from "@/platform/database/schema";

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

it("does not let an older provider event regress the subscription projection", async () => {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `subscription-ordering-${crypto.randomUUID()}`,
      version: 1,
      model: "subscription",
      billingInterval: "month",
      environment: "test",
      providerProductId: `PROD_${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor: 1900n,
      fulfillmentKey: "subscription-ordering",
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
      expectedMinor: 1900n,
      checkoutIdempotencyKey: `checkout:${crypto.randomUUID()}`,
      checkoutState: "created",
      externalOrderId: `SUB_${crypto.randomUUID()}`,
    })
    .returning();
  if (!order) throw new Error("order insert failed");

  await processProviderEvent(
    database.db,
    {
      type: "subscription_activated",
      eventId: `evt:${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
      occurredAt: new Date("2026-08-01T00:00:00Z"),
    },
    "a".repeat(64),
  );

  const latestAt = new Date("2026-08-20T00:00:00Z");
  await processProviderEvent(
    database.db,
    {
      type: "subscription_canceling",
      eventId: `evt:${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      occurredAt: latestAt,
    },
    "b".repeat(64),
  );

  await processProviderEvent(
    database.db,
    {
      type: "subscription_uncanceled",
      eventId: `evt:${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      occurredAt: new Date("2026-08-19T00:00:00Z"),
    },
    "c".repeat(64),
  );

  const projection = await database.db.query.subscriptions.findFirst({
    where: eq(subscriptions.orderId, order.id),
  });
  expect(projection?.status).toBe("canceling");
  expect(projection?.cancelAtPeriodEnd).toBe(true);
  expect(projection?.providerUpdatedAt?.toISOString()).toBe(latestAt.toISOString());
});
