import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  enqueueRefundRequest,
  enqueueSubscriptionCommand,
} from "@/platform/commerce/application/commerce-commands";
import { createPlatformAccountDeletionCoordinator } from "@/platform/accounts/platform-account-deletion-coordinator";
import { createPostgresAccountSubjectRepository } from "@/platform/accounts/postgres-account-subject-repository";
import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import { processProviderEvent } from "@/platform/commerce/application/process-provider-event";
import { reconcileStaleRefunds } from "@/platform/commerce/application/reconcile-stale-refunds";
import { runCommerceCommandWorker } from "@/platform/commerce/application/run-commerce-command-worker";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceAppliedEvents,
  commerceCommandJobs,
  commerceProducts,
  commerceReconciliationRuns,
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
const subjects = createPostgresAccountSubjectRepository(database.db);

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
      billingInterval: "month",
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
      billingInterval: null,
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

function refundProvider(requestRefund: PaymentProvider["requestRefund"]): PaymentProvider {
  return {
    name: "test-provider",
    capabilities: { oneTime: true, subscriptions: true, partialRefunds: true },
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
    requestRefund,
    async getPayment() {
      return null;
    },
    async verifyAndNormalizeWebhook() {
      throw new Error("not used");
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

async function refundCommandFixture(requestedMinor = 700n) {
  await database.db.delete(commerceCommandJobs);
  const fixture = await paidFixture(1000n);
  const idempotencyKey = `refund:${crypto.randomUUID()}`;
  const refund = await enqueueRefundRequest(database.db, {
    subjectId: fixture.subject.id,
    paymentId: fixture.payment.id,
    environment: "test",
    amount: { currency: "USD", minor: requestedMinor },
    reason: "customer request",
    idempotencyKey,
  });
  const job = await database.db.query.commerceCommandJobs.findFirst({
    where: eq(commerceCommandJobs.targetId, refund.id),
  });
  if (!job) throw new Error("refund command job missing");
  return { ...fixture, refund, job, idempotencyKey };
}

async function expectAdditionalRefundRejected(input: {
  readonly subjectId: string;
  readonly paymentId: string;
}) {
  await expect(
    enqueueRefundRequest(database.db, {
      subjectId: input.subjectId,
      paymentId: input.paymentId,
      environment: "test",
      amount: { currency: "USD", minor: 400n },
      reason: "additional partial refund",
      idempotencyKey: `refund:${crypto.randomUUID()}`,
    }),
  ).rejects.toThrow("refund exceeds refundable amount");
}

async function activateSubscription(
  order: Awaited<ReturnType<typeof subscriptionFixture>>["order"],
) {
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

async function waitForBlockedDatabaseOperation(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await database.db.execute(
      sql<{ waiting: number }>`select count(*)::int as waiting from pg_locks where not granted`,
    );
    if (Number(row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("database operation did not reach the expected lock barrier");
}

it("consumes a late activation after deletion without creating an active subscription", async () => {
  const { subject, order } = await subscriptionFixture();
  await subjects.beginDeletion(subject.id);
  const eventId = `evt-late-activate-${crypto.randomUUID()}`;

  await processProviderEvent(
    database.db,
    {
      type: "subscription_activated",
      eventId,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      externalPaymentId: `PAY_${crypto.randomUUID()}`,
      amount: { currency: "USD", minor: 1900n },
      currentPeriodStart: new Date("2026-10-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
      occurredAt: new Date("2026-10-01T00:00:05Z"),
    },
    "f".repeat(64),
  );

  expect(
    await database.db.select().from(subscriptions).where(eq(subscriptions.orderId, order.id)),
  ).toEqual([]);
  expect(
    await database.db
      .select()
      .from(commerceAppliedEvents)
      .where(eq(commerceAppliedEvents.providerEventId, eventId)),
  ).toHaveLength(1);
  const reconciliations = await database.db
    .select()
    .from(commerceReconciliationRuns)
    .where(eq(commerceReconciliationRuns.targetId, order.externalOrderId!));
  expect(reconciliations).toHaveLength(1);
  expect(reconciliations[0]).toMatchObject({ result: "resurrection_blocked" });
});

it("consumes a late uncancel after deletion without restoring active state", async () => {
  const { subject, order } = await subscriptionFixture();
  const subscription = await activateSubscription(order);
  await database.db
    .update(subscriptions)
    .set({ status: "canceling", cancelAtPeriodEnd: true })
    .where(eq(subscriptions.id, subscription.id));
  await subjects.beginDeletion(subject.id);

  await processProviderEvent(
    database.db,
    {
      type: "subscription_uncanceled",
      eventId: `evt-late-uncancel-${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      occurredAt: new Date("2026-09-10T00:00:00Z"),
    },
    "1".repeat(64),
  );

  const retained = await database.db.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscription.id),
  });
  expect(retained).toMatchObject({ status: "canceling", cancelAtPeriodEnd: true });
  expect(
    await database.db
      .select()
      .from(commerceReconciliationRuns)
      .where(eq(commerceReconciliationRuns.targetId, order.externalOrderId!)),
  ).toHaveLength(1);
});

it("lets an uncancel holding the subject fence commit before deletion starts", async () => {
  const { subject, order } = await subscriptionFixture();
  const subscription = await activateSubscription(order);
  await database.db
    .update(subscriptions)
    .set({ status: "canceling", cancelAtPeriodEnd: true })
    .where(eq(subscriptions.id, subscription.id));
  let releaseSubscription!: () => void;
  const subscriptionGate = new Promise<void>((resolve) => {
    releaseSubscription = resolve;
  });
  let subscriptionLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    subscriptionLocked = resolve;
  });
  const blocker = database.db.transaction(async (transaction) => {
    await transaction
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscription.id))
      .for("update");
    subscriptionLocked();
    await subscriptionGate;
  });
  await locked;

  const event = processProviderEvent(
    database.db,
    {
      type: "subscription_uncanceled",
      eventId: `evt-barrier-uncancel-${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      occurredAt: new Date("2026-09-11T00:00:00Z"),
    },
    "2".repeat(64),
  );
  await waitForBlockedDatabaseOperation();
  const deletion = subjects.beginDeletion(subject.id);
  const deletionBeforeRelease = await Promise.race([
    deletion.then(() => "completed" as const),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 75)),
  ]);
  expect(deletionBeforeRelease).toBe("blocked");

  releaseSubscription();
  await blocker;
  await event;
  await deletion;
  expect(
    await database.db.query.accountSubjects.findFirst({
      where: eq(accountSubjects.id, subject.id),
    }),
  ).toMatchObject({ status: "deletion_pending" });
  expect(
    await database.db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscription.id),
    }),
  ).toMatchObject({ status: "active" });
});

it("reconciles a past-due event racing the final deletion scan without retry", async () => {
  const { subject, order } = await subscriptionFixture();
  const subscription = await activateSubscription(order);
  await database.db
    .update(subscriptions)
    .set({ status: "canceling", cancelAtPeriodEnd: true })
    .where(eq(subscriptions.id, subscription.id));
  await subjects.beginDeletion(subject.id);

  const operationKey = crypto.randomUUID();
  const coordinator = createPlatformAccountDeletionCoordinator({
    database: database.db,
    getCommerce: async () => ({ database: database.db }) as never,
  });
  await expect(coordinator.prepare({ subjectId: subject.id, operationKey })).rejects.toThrow(
    "commerce account deletion preparation pending",
  );
  await database.db
    .update(commerceCommandJobs)
    .set({ state: "completed", completedAt: new Date() })
    .where(eq(commerceCommandJobs.subjectId, subject.id));

  let releaseSubscription!: () => void;
  const subscriptionGate = new Promise<void>((resolve) => {
    releaseSubscription = resolve;
  });
  let subscriptionLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    subscriptionLocked = resolve;
  });
  const blocker = database.db.transaction(async (transaction) => {
    await transaction
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscription.id))
      .for("update");
    subscriptionLocked();
    await subscriptionGate;
  });
  await locked;

  const finalScan = coordinator.prepare({ subjectId: subject.id, operationKey });
  await waitForBlockedDatabaseOperation();
  const eventId = `evt-final-scan-past-due-${crypto.randomUUID()}`;
  const event = processProviderEvent(
    database.db,
    {
      type: "subscription_past_due",
      eventId,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      occurredAt: new Date("2026-09-12T00:00:00Z"),
    },
    "3".repeat(64),
  );
  expect(
    await Promise.race([
      event.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 75)),
    ]),
  ).toBe("blocked");

  releaseSubscription();
  await blocker;
  await expect(finalScan).resolves.toBeUndefined();
  await expect(event).resolves.toBeUndefined();

  expect(
    await database.db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subscription.id),
    }),
  ).toMatchObject({ status: "canceling", cancelAtPeriodEnd: true });
  expect(
    await database.db
      .select()
      .from(commerceAppliedEvents)
      .where(eq(commerceAppliedEvents.providerEventId, eventId)),
  ).toHaveLength(1);
  expect(
    await database.db
      .select()
      .from(commerceReconciliationRuns)
      .where(eq(commerceReconciliationRuns.targetId, order.externalOrderId!)),
  ).toContainEqual(expect.objectContaining({ result: "nonterminal_transition_blocked" }));
});

it("does not regress terminal subscriptions after account deletion starts", async () => {
  const cases = [
    { currentStatus: "canceled", eventType: "subscription_canceling" },
    { currentStatus: "expired", eventType: "subscription_canceling" },
    { currentStatus: "closed", eventType: "subscription_canceling" },
    { currentStatus: "expired", eventType: "subscription_canceled" },
    { currentStatus: "closed", eventType: "subscription_canceled" },
  ] as const;

  for (const testCase of cases) {
    const { subject, order } = await subscriptionFixture();
    const subscription = await activateSubscription(order);
    await database.db
      .update(subscriptions)
      .set({ status: testCase.currentStatus, cancelAtPeriodEnd: false })
      .where(eq(subscriptions.id, subscription.id));
    await subjects.beginDeletion(subject.id);
    const eventId = `evt-terminal-${testCase.currentStatus}-${testCase.eventType}-${crypto.randomUUID()}`;
    const event = {
      type: testCase.eventType,
      eventId,
      environment: "test" as const,
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      occurredAt: new Date("2026-10-01T00:00:00Z"),
    };

    await expect(processProviderEvent(database.db, event, "4".repeat(64))).resolves.toBeUndefined();
    await expect(processProviderEvent(database.db, event, "4".repeat(64))).resolves.toBeUndefined();

    expect(
      await database.db.query.subscriptions.findFirst({
        where: eq(subscriptions.id, subscription.id),
      }),
    ).toMatchObject({ status: testCase.currentStatus, cancelAtPeriodEnd: false });
    expect(
      await database.db
        .select()
        .from(commerceAppliedEvents)
        .where(eq(commerceAppliedEvents.providerEventId, eventId)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(commerceReconciliationRuns)
        .where(eq(commerceReconciliationRuns.targetId, order.externalOrderId!)),
    ).toHaveLength(1);
  }
});

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

  const stored = await database.db.select().from(refunds).where(eq(refunds.paymentId, payment.id));
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

it("keeps reconciliation-required refunds reserved against refundable capacity", async () => {
  const { subject, payment } = await paidFixture(1000n);
  await database.db.insert(refunds).values({
    paymentId: payment.id,
    subjectId: subject.id,
    environment: "test",
    idempotencyKey: `refund:${crypto.randomUUID()}`,
    currency: "USD",
    requestedMinor: 700n,
    reason: "provider settlement uncertain",
    status: "reconciliation_required",
  });

  await expect(
    enqueueRefundRequest(database.db, {
      subjectId: subject.id,
      paymentId: payment.id,
      environment: "test",
      amount: { currency: "USD", minor: 400n },
      reason: "additional partial refund",
      idempotencyKey: `refund:${crypto.randomUUID()}`,
    }),
  ).rejects.toThrow("refund exceeds refundable amount");

  const stored = await database.db.select().from(refunds).where(eq(refunds.paymentId, payment.id));
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    requestedMinor: 700n,
    status: "reconciliation_required",
  });
});

it("does not let a late provider response overwrite an authoritative refund webhook", async () => {
  const fixture = await refundCommandFixture(1000n);
  const providerCalled = deferred<void>();
  const providerResult = deferred<{
    externalRefundReference: string;
    status: "pending";
  }>();
  let calls = 0;
  const provider = refundProvider(async (request) => {
    calls += 1;
    expect(request).toMatchObject({
      externalPaymentId: fixture.payment.externalPaymentId,
      idempotencyKey: fixture.idempotencyKey,
      amount: { currency: "USD", minor: 1000n },
    });
    providerCalled.resolve();
    return providerResult.promise;
  });
  const workerNow = new Date("2030-01-01T00:00:00Z");
  const worker = runCommerceCommandWorker({
    database: database.db,
    provider,
    owner: `refund-worker-${crypto.randomUUID()}`,
    now: workerNow,
    limit: 1,
  });
  await providerCalled.promise;

  const webhookOccurredAt = new Date("2030-01-01T00:00:01Z");
  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `evt-refund-race-${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: fixture.payment.externalPaymentId,
      amount: { currency: "USD", minor: 1000n },
      occurredAt: webhookOccurredAt,
    },
    "c".repeat(64),
  );
  providerResult.resolve({
    externalRefundReference: `REF_LATE_${crypto.randomUUID()}`,
    status: "pending",
  });

  expect(await worker).toBe(1);
  expect(calls).toBe(1);
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "succeeded",
    succeededMinor: 1000n,
    reversalStatus: "pending",
    externalRefundReference: null,
    providerUpdatedAt: webhookOccurredAt,
  });
  const persistedPayment = await database.db.query.payments.findFirst({
    where: eq(payments.id, fixture.payment.id),
  });
  expect(persistedPayment).toMatchObject({ refundedMinor: 1000n, refundStatus: "refunded" });
  const persistedJob = await database.db.query.commerceCommandJobs.findFirst({
    where: eq(commerceCommandJobs.id, fixture.job.id),
  });
  expect(persistedJob?.state).toBe("completed");
});

it("does not let a late provider response overwrite stale-refund reconciliation", async () => {
  const fixture = await refundCommandFixture();
  await database.db
    .update(refunds)
    .set({ updatedAt: new Date("2000-01-01T00:00:00Z") })
    .where(eq(refunds.id, fixture.refund.id));
  const providerCalled = deferred<void>();
  const providerResult = deferred<{
    externalRefundReference: string;
    status: "processing";
  }>();
  let calls = 0;
  const provider = refundProvider(async () => {
    calls += 1;
    providerCalled.resolve();
    return providerResult.promise;
  });
  const workerNow = new Date("2030-02-01T00:00:00Z");
  const worker = runCommerceCommandWorker({
    database: database.db,
    provider,
    owner: `refund-worker-${crypto.randomUUID()}`,
    now: workerNow,
    limit: 1,
  });
  await providerCalled.promise;

  expect(
    await reconcileStaleRefunds(database.db, {
      now: new Date("2030-02-03T00:00:00Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
      limit: 1,
    }),
  ).toBe(1);
  providerResult.resolve({
    externalRefundReference: `REF_LATE_${crypto.randomUUID()}`,
    status: "processing",
  });

  expect(await worker).toBe(1);
  expect(calls).toBe(1);
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "reconciliation_required",
    reversalStatus: "pending",
    externalRefundReference: null,
  });
  await expectAdditionalRefundRejected({
    subjectId: fixture.subject.id,
    paymentId: fixture.payment.id,
  });
});

it("does not call the provider again once a refund requires reconciliation", async () => {
  const fixture = await refundCommandFixture();
  await database.db
    .update(refunds)
    .set({ updatedAt: new Date("2000-01-01T00:00:00Z") })
    .where(eq(refunds.id, fixture.refund.id));
  expect(
    await reconcileStaleRefunds(database.db, {
      now: new Date("2030-03-01T00:00:00Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
      limit: 1,
    }),
  ).toBe(1);
  let calls = 0;
  const provider = refundProvider(async () => {
    calls += 1;
    return {
      externalRefundReference: `REF_UNEXPECTED_${crypto.randomUUID()}`,
      status: "processing",
    };
  });

  expect(
    await runCommerceCommandWorker({
      database: database.db,
      provider,
      owner: `refund-worker-${crypto.randomUUID()}`,
      now: new Date("2030-03-01T00:00:01Z"),
      limit: 1,
    }),
  ).toBe(1);
  expect(calls).toBe(0);
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "reconciliation_required",
    reversalStatus: "pending",
    externalRefundReference: null,
  });
  const persistedJob = await database.db.query.commerceCommandJobs.findFirst({
    where: eq(commerceCommandJobs.id, fixture.job.id),
  });
  expect(persistedJob?.state).toBe("completed");
});

it("releases refund capacity after a provider rejection without scheduling reversal", async () => {
  const fixture = await refundCommandFixture();
  const provider = refundProvider(async () => ({
    externalRefundReference: `REF_FAILED_${crypto.randomUUID()}`,
    status: "failed",
  }));

  expect(
    await runCommerceCommandWorker({
      database: database.db,
      provider,
      owner: `refund-worker-${crypto.randomUUID()}`,
      now: new Date("2030-04-01T00:00:00Z"),
      limit: 1,
    }),
  ).toBe(1);
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "failed",
    reversalStatus: "not_required",
    succeededMinor: 0n,
  });
  expect(
    await database.db
      .select()
      .from(fulfillmentJobs)
      .where(eq(fulfillmentJobs.sourceId, fixture.refund.id)),
  ).toHaveLength(0);

  const released = await enqueueRefundRequest(database.db, {
    subjectId: fixture.subject.id,
    paymentId: fixture.payment.id,
    environment: "test",
    amount: { currency: "USD", minor: 400n },
    reason: "replacement partial refund",
    idempotencyKey: `refund:${crypto.randomUUID()}`,
  });
  expect(released.requestedMinor).toBe(400n);
});

it("backs off a thrown provider request while preserving refund capacity", async () => {
  const fixture = await refundCommandFixture();
  const workerNow = new Date("2030-05-01T00:00:00Z");
  const provider = refundProvider(async () => {
    throw new Error("provider unavailable");
  });

  expect(
    await runCommerceCommandWorker({
      database: database.db,
      provider,
      owner: `refund-worker-${crypto.randomUUID()}`,
      now: workerNow,
      limit: 1,
    }),
  ).toBe(0);
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "pending",
    reversalStatus: "pending",
    externalRefundReference: null,
    providerUpdatedAt: null,
  });
  const persistedJob = await database.db.query.commerceCommandJobs.findFirst({
    where: eq(commerceCommandJobs.id, fixture.job.id),
  });
  expect(persistedJob).toMatchObject({
    state: "pending",
    attempts: 1,
    lastErrorCode: "Error",
  });
  expect(persistedJob?.nextAttemptAt.toISOString()).toBe("2030-05-01T00:00:02.000Z");
  await expectAdditionalRefundRejected({
    subjectId: fixture.subject.id,
    paymentId: fixture.payment.id,
  });
});

it.each([
  { providerStatus: "pending" as const, localStatus: "pending" },
  { providerStatus: "processing" as const, localStatus: "processing" },
  { providerStatus: "succeeded" as const, localStatus: "processing" },
])(
  "keeps capacity reserved when the provider reports $providerStatus",
  async ({ providerStatus, localStatus }) => {
    const fixture = await refundCommandFixture();
    const externalRefundReference = `REF_ACCEPTED_${crypto.randomUUID()}`;
    const provider = refundProvider(async () => ({
      externalRefundReference,
      status: providerStatus,
    }));
    const workerNow = new Date("2030-06-01T00:00:00Z");

    expect(
      await runCommerceCommandWorker({
        database: database.db,
        provider,
        owner: `refund-worker-${crypto.randomUUID()}`,
        now: workerNow,
        limit: 1,
      }),
    ).toBe(1);
    const persistedRefund = await database.db.query.refunds.findFirst({
      where: eq(refunds.id, fixture.refund.id),
    });
    expect(persistedRefund).toMatchObject({
      status: localStatus,
      reversalStatus: "pending",
      externalRefundReference,
      providerUpdatedAt: workerNow,
    });
    await expectAdditionalRefundRejected({
      subjectId: fixture.subject.id,
      paymentId: fixture.payment.id,
    });
  },
);

it("refunds only the paid subscription period and accepts the next renewal", async () => {
  const { order } = await subscriptionFixture();
  const subscription = await activateSubscription(order);
  const [periodOne] = await database.db
    .select()
    .from(subscriptionPeriods)
    .where(eq(subscriptionPeriods.subscriptionId, subscription.id));
  if (!periodOne?.paymentId) throw new Error("first subscription period payment missing");
  const paymentOne = await database.db.query.payments.findFirst({
    where: eq(payments.id, periodOne.paymentId),
  });
  if (!paymentOne) throw new Error("first subscription payment missing");

  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `evt-refund-period-${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: paymentOne.externalPaymentId,
      externalRefundReference: `REF_PERIOD_${crypto.randomUUID()}`,
      amount: { currency: "USD", minor: 1900n },
      occurredAt: new Date("2026-08-15T00:00:00Z"),
    },
    "9".repeat(64),
  );

  const refundedPeriod = await database.db.query.subscriptionPeriods.findFirst({
    where: eq(subscriptionPeriods.id, periodOne.id),
  });
  const subscriptionOrder = await database.db.query.orders.findFirst({
    where: eq(orders.id, order.id),
  });
  expect(refundedPeriod?.state).toBe("refunded");
  expect(subscriptionOrder?.status).toBe("paid");

  const paymentTwoExternalId = `PAY_${crypto.randomUUID()}`;
  await processProviderEvent(
    database.db,
    {
      type: "subscription_payment_succeeded",
      eventId: `evt-renew-after-refund-${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      externalPaymentId: paymentTwoExternalId,
      amount: { currency: "USD", minor: 1900n },
      currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
      occurredAt: new Date("2026-09-01T00:00:05Z"),
    },
    "a".repeat(64),
  );

  const periods = await database.db
    .select()
    .from(subscriptionPeriods)
    .where(eq(subscriptionPeriods.subscriptionId, subscription.id));
  expect(periods).toHaveLength(2);
  expect(periods.find((period) => period.id === periodOne.id)?.state).toBe("refunded");
  expect(periods.find((period) => period.paymentId !== periodOne.paymentId)?.state).toBe("paid");
  const renewedOrder = await database.db.query.orders.findFirst({
    where: eq(orders.id, order.id),
  });
  expect(renewedOrder?.status).toBe("paid");
});
