import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { processProviderEvent } from "@/platform/commerce/application/process-provider-event";
import { getCreditBalance } from "@/platform/credits/application/credit-service";
import {
  createCreditOrderFulfillment,
  createCreditRefundReversal,
} from "@/platform/credits/integration/commerce/credit-fulfillment";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceReconciliationRuns,
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

async function refundFixture() {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `refund-replay-${crypto.randomUUID()}`,
      version: 1,
      model: "one_time",
      billingInterval: null,
      environment: "test",
      providerProductId: `PROD_${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor: 1000n,
      fulfillmentKey: "refund-replay",
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
      expectedMinor: 1000n,
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
      amountMinor: 1000n,
      refundedMinor: 0n,
      rawPayloadHash: "a".repeat(64),
    })
    .returning();
  if (!payment) throw new Error("payment insert failed");
  const externalRefundReference = `REF_${crypto.randomUUID()}`;
  const [refund] = await database.db
    .insert(refunds)
    .values({
      paymentId: payment.id,
      subjectId: subject.id,
      environment: "test",
      externalRefundReference,
      idempotencyKey: `refund:${crypto.randomUUID()}`,
      currency: "USD",
      requestedMinor: 1000n,
      reason: "customer request",
      status: "processing",
    })
    .returning();
  if (!refund) throw new Error("refund insert failed");
  return { subject, product, order, payment, refund, externalRefundReference };
}

it("does not double-count the same provider refund reference delivered under a new event id", async () => {
  const { payment, refund, externalRefundReference } = await refundFixture();
  const firstOccurredAt = new Date("2026-08-09T01:00:00Z");
  const event = {
    type: "refund_succeeded" as const,
    environment: "test" as const,
    externalPaymentId: payment.externalPaymentId,
    externalRefundReference,
    amount: { currency: "USD" as const, minor: 1000n },
    occurredAt: firstOccurredAt,
  };

  await processProviderEvent(
    database.db,
    { ...event, eventId: `evt:${crypto.randomUUID()}` },
    "b".repeat(64),
  );
  await processProviderEvent(
    database.db,
    {
      ...event,
      eventId: `evt:${crypto.randomUUID()}`,
      occurredAt: new Date("2026-08-09T01:05:00Z"),
    },
    "c".repeat(64),
  );

  const persistedPayment = await database.db.query.payments.findFirst({
    where: eq(payments.id, payment.id),
  });
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, refund.id),
  });
  expect(persistedPayment?.refundedMinor).toBe(1000n);
  expect(persistedPayment?.refundStatus).toBe("refunded");
  expect(persistedRefund?.status).toBe("succeeded");
  expect(persistedRefund?.succeededMinor).toBe(1000n);
});

it("does not regress a settled refund when an older failure event arrives later", async () => {
  const { payment, refund, externalRefundReference } = await refundFixture();
  const successAt = new Date("2026-08-09T02:00:00Z");
  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `evt:${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: payment.externalPaymentId,
      externalRefundReference,
      amount: { currency: "USD", minor: 1000n },
      occurredAt: successAt,
    },
    "d".repeat(64),
  );

  await processProviderEvent(
    database.db,
    {
      type: "refund_failed",
      eventId: `evt:${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: payment.externalPaymentId,
      externalRefundReference,
      occurredAt: new Date("2026-08-09T01:59:00Z"),
    },
    "e".repeat(64),
  );

  const persistedPayment = await database.db.query.payments.findFirst({
    where: eq(payments.id, payment.id),
  });
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, refund.id),
  });
  expect(persistedPayment?.refundedMinor).toBe(1000n);
  expect(persistedPayment?.refundStatus).toBe("refunded");
  expect(persistedRefund?.status).toBe("succeeded");
  expect(persistedRefund?.providerUpdatedAt?.toISOString()).toBe(successAt.toISOString());
});

it("reconciles a refund reference bound to another payment without mutating either payment", async () => {
  const paymentA = await refundFixture();
  const paymentB = await refundFixture();

  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `evt:${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: paymentB.payment.externalPaymentId,
      externalRefundReference: paymentA.externalRefundReference,
      amount: { currency: "USD", minor: 1000n },
      occurredAt: new Date("2026-08-09T03:00:00Z"),
    },
    "f".repeat(64),
  );

  const [persistedPaymentA, persistedPaymentB, persistedRefundA, persistedRefundB] =
    await Promise.all([
      database.db.query.payments.findFirst({ where: eq(payments.id, paymentA.payment.id) }),
      database.db.query.payments.findFirst({ where: eq(payments.id, paymentB.payment.id) }),
      database.db.query.refunds.findFirst({ where: eq(refunds.id, paymentA.refund.id) }),
      database.db.query.refunds.findFirst({ where: eq(refunds.id, paymentB.refund.id) }),
    ]);
  expect(persistedPaymentA).toMatchObject({ refundedMinor: 0n, refundStatus: "none" });
  expect(persistedPaymentB).toMatchObject({ refundedMinor: 0n, refundStatus: "none" });
  expect(persistedRefundA).toMatchObject({ status: "processing", succeededMinor: 0n });
  expect(persistedRefundB).toMatchObject({ status: "processing", succeededMinor: 0n });

  const reconciliations = await database.db
    .select()
    .from(commerceReconciliationRuns)
    .where(
      and(
        eq(commerceReconciliationRuns.targetType, "payment_refund"),
        eq(commerceReconciliationRuns.targetId, paymentB.payment.id),
      ),
    );
  expect(reconciliations).toHaveLength(1);
  expect(reconciliations[0]?.afterJson).toMatchObject({
    reason: "external_refund_reference_payment_mismatch",
    matchedPaymentId: paymentA.payment.id,
    eventPaymentId: paymentB.payment.id,
  });
});

it("materializes and reverses a provider-originated full refund exactly once", async () => {
  const fixture = await refundFixture();
  await database.db.delete(refunds).where(eq(refunds.id, fixture.refund.id));
  const definition = {
    fulfillmentKey: fixture.product.fulfillmentKey,
    creditType: "reading",
    quantity: 3,
  } as const;
  await createCreditOrderFulfillment(
    database.db,
    definition,
  )({
    sourceType: "payment",
    sourceId: fixture.payment.externalPaymentId,
    operation: `fulfill:${fixture.product.fulfillmentKey}`,
    operationKey: `payment:test:${fixture.payment.externalPaymentId}:fulfill:${fixture.product.fulfillmentKey}`,
  });

  const eventId = `evt-provider-refund-${crypto.randomUUID()}`;
  const externalRefundReference = `REF_PROVIDER_${crypto.randomUUID()}`;
  const event = {
    type: "refund_succeeded" as const,
    eventId,
    environment: "test" as const,
    externalPaymentId: fixture.payment.externalPaymentId,
    externalRefundReference,
    amount: { currency: "USD" as const, minor: 1000n },
    occurredAt: new Date("2026-08-09T04:00:00Z"),
  };
  await processProviderEvent(database.db, event, "1".repeat(64));
  await processProviderEvent(database.db, event, "1".repeat(64));

  const providerRefunds = await database.db
    .select()
    .from(refunds)
    .where(eq(refunds.paymentId, fixture.payment.id));
  expect(providerRefunds).toHaveLength(1);
  const providerRefund = providerRefunds[0]!;
  expect(providerRefund).toMatchObject({
    idempotencyKey: `provider-refund:test:${eventId}`,
    externalRefundReference,
    requestedMinor: 1000n,
    succeededMinor: 1000n,
    status: "succeeded",
    reversalStatus: "pending",
  });
  const jobs = await database.db
    .select()
    .from(fulfillmentJobs)
    .where(eq(fulfillmentJobs.sourceId, providerRefund.id));
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    sourceType: "refund",
    operation: `reverse:${fixture.product.fulfillmentKey}`,
  });

  await createCreditRefundReversal(
    database.db,
    definition,
  )({
    sourceType: "refund",
    sourceId: providerRefund.id,
    operation: `reverse:${fixture.product.fulfillmentKey}`,
    operationKey: jobs[0]!.idempotencyKey,
  });
  expect(
    await getCreditBalance(database.db, {
      subjectId: fixture.subject.id,
      creditType: definition.creditType,
    }),
  ).toMatchObject({ available: 0 });
  const reversed = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, providerRefund.id),
  });
  expect(reversed?.reversalStatus).toBe("completed");
});
