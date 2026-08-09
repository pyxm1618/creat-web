import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  enqueueRefundRequest,
  enqueueSubscriptionCommand,
} from "@/platform/commerce/application/commerce-commands";
import { processProviderEvent } from "@/platform/commerce/application/process-provider-event";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceAppliedEvents,
  commerceCommandJobs,
  commerceProducts,
  fulfillmentJobs,
  orders,
  payments,
  refunds,
  subscriptionPeriods,
  subscriptions,
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

async function subscriptionFixture() {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `subscription-${crypto.randomUUID()}`,
      version: 1,
      model: "subscription",
      environment: "test",
      providerProductId: `PROD_${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor: 1900n,
      fulfillmentKey: "subscription-credits",
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
      status: "pending",
      expectedCurrency: "USD",
      expectedMinor: 1900n,
      checkoutIdempotencyKey: `checkout:${crypto.randomUUID()}`,
      checkoutState: "created",
      externalOrderId: `SUB_${crypto.randomUUID()}`,
    })
    .returning();
  if (!order) throw new Error("order insert failed");
  return { subject, product, order };
}

async function paidFixture(amountMinor = 1000n) {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `one-time-${crypto.randomUUID()}`,
      version: 1,
      model: "one_time",
      environment: "test",
      providerProductId: `PROD_${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor: amountMinor,
      fulfillmentKey: "one-time-credits",
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
      expectedMinor: amountMinor,
      checkoutIdempotencyKey: `checkout:${crypto.randomUUID()}`,
      checkoutState: "created",
      externalOrderId: `ORD_${crypto.randomUUID()}`,
      paidAt: new Date("2026-08-09T00:00:00Z"),
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
      amountMinor,
      refundedMinor: 0n,
      rawPayloadHash: "a".repeat(64),
    })
    .returning();
  if (!payment) throw new Error("payment insert failed");
  return { subject, product, order, payment };
}

async function activateSubscription(order: Awaited<ReturnType<typeof subscriptionFixture>>["order"]) {
  const periodStart = new Date("2026-08-01T00:00:00Z");
  const periodEnd = new Date("2026-09-01T00:00:00Z");
  await processProviderEvent(
    database.db,
    {
      type: "subscription_activated",
      eventId: `evt-activate-${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      externalPaymentId: `PAY_${crypto.randomUUID()}`,
      amount: { currency: "USD", minor: 1900n },
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      occurredAt: periodStart,
    },
    "b".repeat(64),
  );
  const subscription = await database.db.query.subscriptions.findFirst({
    where: eq(subscriptions.orderId, order.id),
  });
  if (!subscription) throw new Error("subscription projection missing");
  return subscription;
}

it("does not extend the grace deadline when repeated past-due events arrive", async () => {
  const { order } = await subscriptionFixture();
  const subscription = await activateSubscription(order);

  const firstPastDue = new Date("2026-09-02T12:00:00Z");
  await processProviderEvent(
    database.db,
    {
      type: "subscription_past_due",
      eventId: `evt-past-due-${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      occurredAt: firstPastDue,
    },
    "c".repeat(64),
  );
  const first = await database.db.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscription.id),
  });
  expect(first?.status).toBe("past_due");
  expect(first?.pastDueStartedAt?.toISOString()).toBe(firstPastDue.toISOString());
  const originalGraceEnd = first?.pastDueGraceEndsAt?.toISOString();
  expect(originalGraceEnd).toBeTruthy();

  await processProviderEvent(
    database.db,
    {
      type: "subscription_past_due",
      eventId: `evt-past-due-${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      occurredAt: new Date("2026-09-06T12:00:00Z"),
    },
    "d".repeat(64),
  );
  const repeated = await database.db.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscription.id),
  });
  expect(repeated?.pastDueStartedAt?.toISOString()).toBe(firstPastDue.toISOString());
  expect(repeated?.pastDueGraceEndsAt?.toISOString()).toBe(originalGraceEnd);
  expect(repeated?.gracePolicyVersion).toBe(first?.gracePolicyVersion);
});

it("applies a replayed renewal event exactly once", async () => {
  const { order } = await subscriptionFixture();
  const subscription = await activateSubscription(order);
  const eventId = `evt-renew-${crypto.randomUUID()}`;
  const externalPaymentId = `PAY_${crypto.randomUUID()}`;
  const event = {
    type: "subscription_payment_succeeded" as const,
    eventId,
    environment: "test" as const,
    externalOrderId: order.externalOrderId!,
    merchantOrderReference: order.id,
    externalPaymentId,
    amount: { currency: "USD" as const, minor: 1900n },
    currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
    occurredAt: new Date("2026-09-01T00:00:05Z"),
  };

  await processProviderEvent(database.db, event, "e".repeat(64));
  await processProviderEvent(database.db, event, "e".repeat(64));

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

  const periods = await database.db
    .select()
    .from(subscriptionPeriods)
    .where(eq(subscriptionPeriods.subscriptionId, subscription.id));
  expect(periods).toHaveLength(2);

  const renewalJobs = await database.db
    .select()
    .from(fulfillmentJobs)
    .where(eq(fulfillmentJobs.sourceId, externalPaymentId));
  expect(renewalJobs).toHaveLength(1);
});

it("keeps subscription command retries idempotent after the projected status changes", async () => {
  const { subject, order } = await subscriptionFixture();
  const subscription = await activateSubscription(order);
  const idempotencyKey = `cancel:${crypto.randomUUID()}`;

  const first = await enqueueSubscriptionCommand(database.db, {
    subjectId: subject.id,
    subscriptionId: subscription.id,
    command: "subscription_cancel",
    idempotencyKey,
  });
  await database.db
    .update(subscriptions)
    .set({ status: "canceling", cancelAtPeriodEnd: true })
    .where(eq(subscriptions.id, subscription.id));
  const repeated = await enqueueSubscriptionCommand(database.db, {
    subjectId: subject.id,
    subscriptionId: subscription.id,
    command: "subscription_cancel",
    idempotencyKey,
  });

  expect(repeated.id).toBe(first.id);
  const jobs = await database.db
    .select()
    .from(commerceCommandJobs)
    .where(eq(commerceCommandJobs.idempotencyKey, idempotencyKey));
  expect(jobs).toHaveLength(1);
});

it("returns the same refund for an idempotent retry even after the balance is fully reserved", async () => {
  const { subject, payment } = await paidFixture(1000n);
  const idempotencyKey = `refund:${crypto.randomUUID()}`;
  const request = {
    subjectId: subject.id,
    paymentId: payment.id,
    environment: "test" as const,
    amount: { currency: "USD" as const, minor: 1000n },
    reason: "customer request",
    idempotencyKey,
  };

  const first = await enqueueRefundRequest(database.db, request);
  const repeated = await enqueueRefundRequest(database.db, request);
  expect(repeated.id).toBe(first.id);

  const stored = await database.db
    .select()
    .from(refunds)
    .where(eq(refunds.paymentId, payment.id));
  expect(stored).toHaveLength(1);
});

it("serializes concurrent refund reservations so cumulative requested refunds cannot exceed capture", async () => {
  const { subject, payment } = await paidFixture(1000n);
  const requests = [
    enqueueRefundRequest(database.db, {
      subjectId: subject.id,
      paymentId: payment.id,
      environment: "test",
      amount: { currency: "USD", minor: 600n },
      reason: "partial refund A",
      idempotencyKey: `refund:${crypto.randomUUID()}`,
    }),
    enqueueRefundRequest(database.db, {
      subjectId: subject.id,
      paymentId: payment.id,
      environment: "test",
      amount: { currency: "USD", minor: 600n },
      reason: "partial refund B",
      idempotencyKey: `refund:${crypto.randomUUID()}`,
    }),
  ];

  const settled = await Promise.allSettled(requests);
  expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);

  const [total] = await database.db
    .select({
      requested: sql<bigint>`coalesce(sum(${refunds.requestedMinor}), 0)::bigint`,
    })
    .from(refunds)
    .where(eq(refunds.paymentId, payment.id));
  expect(BigInt(total?.requested ?? 0n)).toBe(600n);
});
