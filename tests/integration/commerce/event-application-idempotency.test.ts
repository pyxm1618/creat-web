import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { processProviderEvent } from "@/platform/commerce/application/process-provider-event";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceAppliedEvents,
  commerceProducts,
  fulfillmentJobs,
  orders,
  payments,
  refunds,
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

async function paidFixture() {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `product-${crypto.randomUUID()}`,
      version: 1,
      model: "one_time",
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
      status: "paid",
      expectedCurrency: "USD",
      expectedMinor: 2900n,
      checkoutIdempotencyKey: `checkout:${crypto.randomUUID()}`,
      checkoutState: "created",
      externalOrderId: `ORD_${crypto.randomUUID()}`,
    })
    .returning();
  if (!order) throw new Error("order insert failed");
  const [payment] = await database.db
    .insert(payments)
    .values({
      orderId: order.id,
      environment: "test",
      externalPaymentId: `PAY_${crypto.randomUUID()}`,
      status: "succeeded",
      refundStatus: "none",
      currency: "USD",
      amountMinor: 2900n,
      refundedMinor: 0n,
      rawPayloadHash: "a".repeat(64),
    })
    .returning();
  if (!payment) throw new Error("payment insert failed");
  return { order, payment };
}

it("replaying the same refund provider event changes the ledger exactly once", async () => {
  const { payment } = await paidFixture();
  const eventId = `refund-delivery-${crypto.randomUUID()}`;
  const event = {
    type: "refund_succeeded" as const,
    eventId,
    environment: "test" as const,
    externalPaymentId: payment.externalPaymentId,
    amount: { currency: "USD" as const, minor: 1000n },
    occurredAt: new Date("2026-08-08T08:00:00Z"),
  };

  await processProviderEvent(database.db, event, "b".repeat(64));
  await processProviderEvent(database.db, event, "b".repeat(64));

  const stored = await database.db.query.payments.findFirst({
    where: and(
      eq(payments.environment, "test"),
      eq(payments.externalPaymentId, payment.externalPaymentId),
    ),
  });
  expect(stored).toMatchObject({ refundedMinor: 1000n, refundStatus: "partial" });

  const providerRefunds = await database.db
    .select()
    .from(refunds)
    .where(eq(refunds.paymentId, payment.id));
  expect(providerRefunds).toHaveLength(1);
  expect(providerRefunds[0]).toMatchObject({
    idempotencyKey: `provider-refund:test:${eventId}`,
    requestedMinor: 1000n,
    succeededMinor: 1000n,
    status: "succeeded",
    reversalStatus: "reconciliation_required",
  });
  const reversalJobs = await database.db
    .select()
    .from(fulfillmentJobs)
    .where(eq(fulfillmentJobs.sourceType, "refund"));
  expect(reversalJobs).toHaveLength(0);

  const applications = await database.db
    .select()
    .from(commerceAppliedEvents)
    .where(
      and(
        eq(commerceAppliedEvents.environment, "test"),
        eq(commerceAppliedEvents.providerEventId, eventId),
      ),
    );
  expect(applications).toHaveLength(1);
});
