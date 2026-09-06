import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, ne, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  enqueueRefundRequest,
  enqueueSubscriptionCommand,
} from "@/platform/commerce/application/commerce-commands";
import { createPlatformAccountDeletionCoordinator } from "@/platform/accounts/platform-account-deletion-coordinator";
import { createPostgresAccountSubjectRepository } from "@/platform/accounts/postgres-account-subject-repository";
import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import {
  processProviderEvent,
  processProviderEventInTransaction,
} from "@/platform/commerce/application/process-provider-event";
import { reconcileStaleRefunds } from "@/platform/commerce/application/reconcile-stale-refunds";
import {
  applyRefundSettlementResultInTransaction,
  reconcileRefundSettlements,
} from "@/platform/commerce/application/reconcile-refund-settlements";
import { runCommerceCommandWorker } from "@/platform/commerce/application/run-commerce-command-worker";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  authSecurityEvents,
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

function refundProvider(
  requestRefund: PaymentProvider["requestRefund"],
  getRefundSettlement: PaymentProvider["getRefundSettlement"] = async () => ({
    status: "not_found" as const,
  }),
): PaymentProvider {
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
    getRefundSettlement,
    async getPayment() {
      return { payments: [], warnings: [] };
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

async function waitForDatabaseLockWait(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await database.db.execute(
      sql`select wait_event_type from pg_stat_activity where pid = ${pid}`,
    );
    const waitEventType = (activity[0] as { wait_event_type?: string | null } | undefined)
      ?.wait_event_type;
    if (waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`database transaction ${pid} did not wait on a lock`);
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

async function securityEventCount(eventType: string): Promise<number> {
  const [row] = await database.db
    .select({ count: sql<number>`count(*)::int` })
    .from(authSecurityEvents)
    .where(eq(authSecurityEvents.eventType, eventType));
  return row?.count ?? 0;
}

async function startFinalRefundAttempt(requestedMinor = 1000n) {
  const fixture = await refundCommandFixture(requestedMinor);
  await database.db
    .update(commerceCommandJobs)
    .set({ attempts: 11 })
    .where(eq(commerceCommandJobs.id, fixture.job.id));
  const providerCalled = deferred<void>();
  const releaseProvider = deferred<void>();
  let calls = 0;
  const provider = refundProvider(async () => {
    calls += 1;
    providerCalled.resolve();
    await releaseProvider.promise;
    throw new Error("provider unavailable on final attempt");
  });
  const worker = runCommerceCommandWorker({
    database: database.db,
    provider,
    owner: `refund-worker-${crypto.randomUUID()}`,
    now: new Date("2031-01-01T00:00:00Z"),
    limit: 1,
  });
  await providerCalled.promise;
  return { fixture, releaseProvider, worker, calls: () => calls };
}

async function expectFinalAttemptDeadLetter(input: {
  readonly jobId: string;
  readonly deadLetterCountBefore: number;
}) {
  const persistedJob = await database.db.query.commerceCommandJobs.findFirst({
    where: eq(commerceCommandJobs.id, input.jobId),
  });
  expect(persistedJob).toMatchObject({
    state: "dead_letter",
    attempts: 12,
    lastErrorCode: "ProviderWriteOutcomeUnknownError",
  });
  expect(await securityEventCount("dead_letter_created")).toBe(input.deadLetterCountBefore + 1);
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
      refundIntentReference: fixture.refund.id,
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

  await database.db
    .update(refunds)
    .set({ updatedAt: new Date("2000-01-01T00:00:00Z") })
    .where(eq(refunds.id, fixture.refund.id));

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
    reversalStatus: "reconciliation_required",
    externalRefundReference: null,
    providerWriteState: "ambiguous",
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
    reversalStatus: "reconciliation_required",
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
      clock: () => workerNow,
    }),
  ).toBe(0);
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "reconciliation_required",
    reversalStatus: "reconciliation_required",
    externalRefundReference: null,
    providerUpdatedAt: null,
  });
  const persistedJob = await database.db.query.commerceCommandJobs.findFirst({
    where: eq(commerceCommandJobs.id, fixture.job.id),
  });
  expect(persistedJob).toMatchObject({
    state: "pending",
    attempts: 1,
    lastErrorCode: "ProviderWriteOutcomeUnknownError",
  });
  expect(persistedJob?.nextAttemptAt.toISOString()).toBe("2030-05-01T00:00:02.000Z");
  await expectAdditionalRefundRejected({
    subjectId: fixture.subject.id,
    paymentId: fixture.payment.id,
  });
});

it("reconciles an ambiguous provider write without issuing a second refund request", async () => {
  const fixture = await refundCommandFixture();
  const workerNow = new Date("2030-06-01T00:00:00Z");
  let requestCalls = 0;
  let settlementReads = 0;
  const provider = refundProvider(
    async () => {
      requestCalls += 1;
      throw new Error("provider response lost after dispatch");
    },
    async (input) => {
      settlementReads += 1;
      expect(input).toMatchObject({
        externalPaymentId: fixture.payment.externalPaymentId,
        refundIntentReference: fixture.refund.id,
      });
      return {
        status: "succeeded" as const,
        externalRefundReference: "TKT_RECONCILED",
        externalSettlementReference: "REF_RECONCILED",
        amount: { currency: "USD" as const, minor: 700n },
      };
    },
  );

  expect(
    await runCommerceCommandWorker({
      database: database.db,
      provider,
      owner: `refund-worker-${crypto.randomUUID()}`,
      now: workerNow,
      clock: () => workerNow,
      limit: 1,
    }),
  ).toBe(0);
  expect(
    await runCommerceCommandWorker({
      database: database.db,
      provider,
      owner: `refund-worker-${crypto.randomUUID()}`,
      now: new Date(workerNow.getTime() + 2_000),
      clock: () => new Date(workerNow.getTime() + 2_000),
      limit: 1,
    }),
  ).toBe(1);

  expect(requestCalls).toBe(1);
  expect(settlementReads).toBe(1);
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "succeeded",
    externalRefundReference: "TKT_RECONCILED",
  });
});

it("reconciles after local persistence fails without issuing a second provider write", async () => {
  const fixture = await refundCommandFixture();
  const workerNow = new Date("2030-06-15T00:00:00Z");
  let requestCalls = 0;
  let settlementReads = 0;
  await database.db.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION refund_persist_failure_test()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.provider_write_state = 'confirmed' AND OLD.provider_write_state = 'dispatched' THEN
          RAISE EXCEPTION 'intentional local persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `),
  );
  await database.db.execute(
    sql.raw(`
      CREATE TRIGGER refund_persist_failure_test_trigger
      BEFORE UPDATE ON refunds
      FOR EACH ROW EXECUTE FUNCTION refund_persist_failure_test();
    `),
  );

  try {
    const provider = refundProvider(
      async () => {
        requestCalls += 1;
        return {
          externalRefundReference: "TKT_DB_PERSISTENCE_FAILURE",
          status: "pending" as const,
        };
      },
      async () => {
        settlementReads += 1;
        return {
          status: "succeeded" as const,
          externalRefundReference: "TKT_DB_PERSISTENCE_FAILURE",
          externalSettlementReference: "REF_DB_PERSISTENCE_FAILURE",
          amount: { currency: "USD" as const, minor: 700n },
        };
      },
    );

    await expect(
      runCommerceCommandWorker({
        database: database.db,
        provider,
        owner: `refund-worker-${crypto.randomUUID()}`,
        now: workerNow,
        clock: () => workerNow,
        limit: 1,
      }),
    ).resolves.toBe(0);
    expect(requestCalls).toBe(1);

    await database.db.execute(
      sql.raw("DROP TRIGGER refund_persist_failure_test_trigger ON refunds"),
    );
    await database.db.execute(sql.raw("DROP FUNCTION refund_persist_failure_test()"));

    await expect(
      runCommerceCommandWorker({
        database: database.db,
        provider,
        owner: `refund-worker-${crypto.randomUUID()}`,
        now: new Date(workerNow.getTime() + 2_000),
        clock: () => new Date(workerNow.getTime() + 2_000),
        limit: 1,
      }),
    ).resolves.toBe(1);
    expect(requestCalls).toBe(1);
    expect(settlementReads).toBe(1);
    expect(
      await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
    ).toMatchObject({ status: "succeeded", externalRefundReference: "TKT_DB_PERSISTENCE_FAILURE" });
  } finally {
    await database.db.execute(
      sql.raw("DROP TRIGGER IF EXISTS refund_persist_failure_test_trigger ON refunds"),
    );
    await database.db.execute(sql.raw("DROP FUNCTION IF EXISTS refund_persist_failure_test()"));
  }
});

it("settles a dispatched refund from scheduled provider read without a webhook ledger event", async () => {
  const fixture = await refundCommandFixture(1000n);
  const now = new Date("2030-07-01T00:00:00Z");
  await database.db
    .update(refunds)
    .set({
      status: "processing",
      reversalStatus: "pending",
      providerWriteState: "dispatched",
      nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
    })
    .where(eq(refunds.id, fixture.refund.id));

  let requestCalls = 0;
  let readCalls = 0;
  const provider = refundProvider(
    async () => {
      requestCalls += 1;
      throw new Error("scheduled reconciliation must not POST");
    },
    async (input) => {
      readCalls += 1;
      expect(input).toMatchObject({
        externalPaymentId: fixture.payment.externalPaymentId,
        refundIntentReference: fixture.refund.id,
      });
      return {
        status: "succeeded" as const,
        externalRefundReference: "TKT_SCHEDULED",
        externalSettlementReference: "REF_SCHEDULED",
        amount: { currency: "USD" as const, minor: 1000n },
      };
    },
  );

  await expect(reconcileRefundSettlements(database.db, provider, { now, limit: 1 })).resolves.toBe(
    1,
  );
  expect(requestCalls).toBe(0);
  expect(readCalls).toBe(1);
  expect(
    await database.db
      .select()
      .from(fulfillmentJobs)
      .where(eq(fulfillmentJobs.sourceId, fixture.refund.id)),
  ).toHaveLength(1);
  expect(
    await database.db
      .select()
      .from(commerceAppliedEvents)
      .where(eq(commerceAppliedEvents.providerEventId, `provider-read:${fixture.refund.id}`)),
  ).toHaveLength(0);
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({ status: "succeeded", externalRefundReference: "TKT_SCHEDULED" });
});

it("deduplicates a delayed webhook after provider-read settlement", async () => {
  const fixture = await refundCommandFixture(500n);
  const now = new Date("2030-07-02T00:00:00Z");
  const ticketReference = `TKT_READ_FIRST_${crypto.randomUUID()}`;
  const settlementReference = `REF_READ_FIRST_${crypto.randomUUID()}`;
  await database.db
    .update(refunds)
    .set({
      status: "processing",
      reversalStatus: "pending",
      providerWriteState: "dispatched",
      nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
    })
    .where(eq(refunds.id, fixture.refund.id));
  await database.db
    .update(refunds)
    .set({ nextProviderReconciliationAt: null })
    .where(ne(refunds.id, fixture.refund.id));

  let readCalls = 0;
  const provider = refundProvider(
    async () => {
      throw new Error("delayed webhook scenario must not issue a provider write");
    },
    async () => {
      readCalls += 1;
      return {
        status: "succeeded" as const,
        externalRefundReference: ticketReference,
        externalSettlementReference: settlementReference,
        amount: { currency: "USD" as const, minor: 500n },
      };
    },
  );

  await expect(reconcileRefundSettlements(database.db, provider, { now, limit: 1 })).resolves.toBe(
    1,
  );
  expect(readCalls).toBe(1);
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({
    status: "succeeded",
    externalRefundReference: ticketReference,
    externalSettlementReference: settlementReference,
  });

  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `evt-delayed-refund-webhook-${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: fixture.payment.externalPaymentId,
      merchantOrderReference: fixture.order.id,
      externalRefundReference: settlementReference,
      amount: { currency: "USD", minor: 500n },
      occurredAt: new Date(now.getTime() + 1_000),
    },
    "delayed-refund-webhook".padEnd(64, "0"),
  );

  expect(
    await database.db.query.payments.findFirst({ where: eq(payments.id, fixture.payment.id) }),
  ).toMatchObject({ refundStatus: "partial", refundedMinor: 500n });
  expect(
    await database.db.select().from(refunds).where(eq(refunds.paymentId, fixture.payment.id)),
  ).toHaveLength(1);
  expect(
    await database.db
      .select()
      .from(fulfillmentJobs)
      .where(eq(fulfillmentJobs.sourceId, fixture.refund.id)),
  ).toHaveLength(0);
});

it("preserves partial-refund operator review after provider-read settlement", async () => {
  const fixture = await refundCommandFixture(500n);
  const now = new Date("2030-07-03T00:00:00Z");
  await database.db
    .update(refunds)
    .set({
      status: "processing",
      reversalStatus: "pending",
      providerWriteState: "dispatched",
      nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
    })
    .where(eq(refunds.id, fixture.refund.id));
  await database.db
    .update(refunds)
    .set({ nextProviderReconciliationAt: null })
    .where(ne(refunds.id, fixture.refund.id));

  const provider = refundProvider(
    async () => {
      throw new Error("partial provider-read scenario must not issue a provider write");
    },
    async () => ({
      status: "succeeded" as const,
      externalRefundReference: "TKT_PARTIAL_READ",
      externalSettlementReference: "REF_PARTIAL_READ",
      amount: { currency: "USD" as const, minor: 500n },
    }),
  );

  await expect(reconcileRefundSettlements(database.db, provider, { now, limit: 1 })).resolves.toBe(
    1,
  );
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({
    status: "succeeded",
    reversalStatus: "reconciliation_required",
    operatorReviewReason: "partial refund entitlement reversal requires operator policy",
  });
});

it("does not apply a stale provider read after a webhook settlement commits", async () => {
  const fixture = await refundCommandFixture(1000n);
  await database.db
    .update(refunds)
    .set({
      status: "processing",
      reversalStatus: "pending",
      providerWriteState: "dispatched",
      nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
    })
    .where(eq(refunds.id, fixture.refund.id));

  const staleRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, fixture.refund.id),
  });
  if (!staleRefund) throw new Error("stale refund fixture missing");
  const staleCandidate = {
    refund: staleRefund,
    externalPaymentId: fixture.payment.externalPaymentId,
    paymentAmount: { currency: "USD" as const, minor: 1000n },
    orderId: fixture.order.id,
    externalOrderId: fixture.order.externalOrderId,
    sourceState: {
      refundStatus: staleRefund.status,
      providerWriteState: staleRefund.providerWriteState,
      reversalStatus: staleRefund.reversalStatus,
      succeededMinor: staleRefund.succeededMinor,
      externalRefundReference: staleRefund.externalRefundReference,
      externalSettlementReference: staleRefund.externalSettlementReference,
      nextProviderReconciliationAt: staleRefund.nextProviderReconciliationAt,
      reconciliationLeaseOwner: staleRefund.reconciliationLeaseOwner,
      reconciliationLeaseExpiresAt: staleRefund.reconciliationLeaseExpiresAt,
      paymentRefundStatus: fixture.payment.refundStatus,
      paymentRefundedMinor: fixture.payment.refundedMinor,
      orderStatus: fixture.order.status,
    },
  } as Parameters<typeof applyRefundSettlementResultInTransaction>[1];

  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `evt-refund-stale-read-race-${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: fixture.payment.externalPaymentId,
      merchantOrderReference: fixture.order.id,
      amount: { currency: "USD", minor: 1000n },
      occurredAt: new Date("2030-09-01T00:00:01Z"),
    },
    "f".repeat(64),
  );

  await database.db.transaction(async (tx) => {
    await applyRefundSettlementResultInTransaction(
      tx,
      staleCandidate,
      {
        status: "succeeded",
        externalRefundReference: "TKT_STALE_PROVIDER_READ",
        externalSettlementReference: "REF_STALE_PROVIDER_READ",
        amount: { currency: "USD", minor: 1000n },
      },
      new Date("2030-09-01T00:00:02Z"),
    );
  });

  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "succeeded",
    succeededMinor: 1000n,
    reversalStatus: "pending",
    providerWriteState: "confirmed",
    externalRefundReference: null,
  });
  const persistedPayment = await database.db.query.payments.findFirst({
    where: eq(payments.id, fixture.payment.id),
  });
  expect(persistedPayment).toMatchObject({ refundedMinor: 1000n, refundStatus: "refunded" });
  expect(
    await database.db
      .select()
      .from(fulfillmentJobs)
      .where(eq(fulfillmentJobs.sourceId, fixture.refund.id)),
  ).toHaveLength(1);
});

it("retires a refund read candidate after an authoritative payment settlement", async () => {
  const fixture = await refundCommandFixture(1000n);
  const now = new Date("2030-09-15T00:00:00Z");
  await database.db
    .update(refunds)
    .set({
      status: "processing",
      reversalStatus: "pending",
      providerWriteState: "dispatched",
      nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
    })
    .where(eq(refunds.id, fixture.refund.id));
  await database.db
    .update(payments)
    .set({ refundStatus: "refunded", refundedMinor: 1000n })
    .where(eq(payments.id, fixture.payment.id));
  await database.db
    .update(orders)
    .set({ status: "refunded" })
    .where(eq(orders.id, fixture.order.id));
  await database.db
    .update(refunds)
    .set({ nextProviderReconciliationAt: null })
    .where(ne(refunds.id, fixture.refund.id));

  let readCalls = 0;
  const provider = refundProvider(
    async () => {
      throw new Error("authoritative settlement must not issue a provider write");
    },
    async () => {
      readCalls += 1;
      return { status: "not_found" as const };
    },
  );

  await expect(reconcileRefundSettlements(database.db, provider, { now, limit: 1 })).resolves.toBe(
    1,
  );
  expect(readCalls).toBe(1);
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({
    status: "processing",
    nextProviderReconciliationAt: null,
    operatorReviewReason:
      "provider read ignored because authoritative local refund state changed before apply",
  });

  await expect(reconcileRefundSettlements(database.db, provider, { now, limit: 1 })).resolves.toBe(
    0,
  );
  expect(readCalls).toBe(1);
});

it("claims a refund candidate before provider lookup so overlapping jobs read it once", async () => {
  const fixture = await refundCommandFixture(1000n);
  const now = new Date("2030-09-16T00:00:00Z");
  await database.db
    .update(refunds)
    .set({
      status: "processing",
      reversalStatus: "pending",
      providerWriteState: "dispatched",
      nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
    })
    .where(eq(refunds.id, fixture.refund.id));
  await database.db
    .update(refunds)
    .set({ nextProviderReconciliationAt: null })
    .where(ne(refunds.id, fixture.refund.id));

  const firstReadStarted = deferred<void>();
  const releaseFirstRead = deferred<void>();
  let readCalls = 0;
  const provider = refundProvider(
    async () => {
      throw new Error("overlapping reconciliation must not issue a provider write");
    },
    async () => {
      readCalls += 1;
      if (readCalls === 1) {
        firstReadStarted.resolve();
        await releaseFirstRead.promise;
      }
      return { status: "not_found" as const };
    },
  );

  const firstReconciliation = reconcileRefundSettlements(database.db, provider, {
    now,
    limit: 1,
  });
  await firstReadStarted.promise;
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({
    reconciliationLeaseOwner: expect.any(String),
    reconciliationLeaseExpiresAt: expect.any(Date),
  });
  await expect(reconcileRefundSettlements(database.db, provider, { now, limit: 1 })).resolves.toBe(
    0,
  );

  releaseFirstRead.resolve();
  await expect(firstReconciliation).resolves.toBe(1);
  expect(readCalls).toBe(1);
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({
    providerReconciliationAttempts: 1,
    reconciliationLeaseOwner: null,
    reconciliationLeaseExpiresAt: null,
  });
});

it("reclaims a refund reconciliation lease after a worker aborts", async () => {
  const fixture = await refundCommandFixture(1000n);
  const now = new Date("2030-09-16T00:00:00Z");
  await database.db
    .update(refunds)
    .set({
      status: "processing",
      reversalStatus: "pending",
      providerWriteState: "dispatched",
      nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
    })
    .where(eq(refunds.id, fixture.refund.id));
  await database.db
    .update(refunds)
    .set({ nextProviderReconciliationAt: null })
    .where(ne(refunds.id, fixture.refund.id));

  const firstReadStarted = deferred<void>();
  const controller = new AbortController();
  let readCalls = 0;
  const provider = refundProvider(
    async () => {
      throw new Error("lease recovery must not issue a provider write");
    },
    async () => {
      readCalls += 1;
      if (readCalls === 1) {
        firstReadStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          const rejectOnAbort = () =>
            reject(controller.signal.reason ?? new DOMException("aborted", "AbortError"));
          if (controller.signal.aborted) {
            rejectOnAbort();
            return;
          }
          controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
      }
      return { status: "not_found" as const };
    },
  );

  const abortedReconciliation = reconcileRefundSettlements(database.db, provider, {
    now,
    limit: 1,
    signal: controller.signal,
  });
  await firstReadStarted.promise;
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({
    reconciliationLeaseOwner: expect.any(String),
    reconciliationLeaseExpiresAt: expect.any(Date),
  });

  controller.abort(new DOMException("worker aborted", "AbortError"));
  await expect(abortedReconciliation).rejects.toMatchObject({ name: "AbortError" });

  await expect(
    reconcileRefundSettlements(database.db, provider, {
      now: new Date(now.getTime() + 29_000),
      limit: 1,
    }),
  ).resolves.toBe(0);
  expect(readCalls).toBe(1);

  await expect(
    reconcileRefundSettlements(database.db, provider, {
      now: new Date(now.getTime() + 31_000),
      limit: 1,
    }),
  ).resolves.toBe(1);
  expect(readCalls).toBe(2);
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({
    providerReconciliationAttempts: 1,
    reconciliationLeaseOwner: null,
    reconciliationLeaseExpiresAt: null,
  });
});

it("keeps webhook and reconciliation settlement lock order consistent under concurrency", async () => {
  for (let round = 0; round < 5; round += 1) {
    const fixture = await refundCommandFixture(1000n);
    const reconciliationAt = new Date(`2030-09-${20 + round}T00:00:00.000Z`);
    await database.db
      .update(refunds)
      .set({
        status: "processing",
        reversalStatus: "pending",
        providerWriteState: "dispatched",
        externalRefundReference: `TKT_CONCURRENT_${round}`,
        nextProviderReconciliationAt: new Date("2000-01-01T00:00:00Z"),
      })
      .where(eq(refunds.id, fixture.refund.id));
    await database.db
      .update(refunds)
      .set({ nextProviderReconciliationAt: null })
      .where(ne(refunds.id, fixture.refund.id));

    const staleRefund = await database.db.query.refunds.findFirst({
      where: eq(refunds.id, fixture.refund.id),
    });
    if (!staleRefund) throw new Error("concurrent refund fixture missing");
    const candidate = {
      refund: staleRefund,
      externalPaymentId: fixture.payment.externalPaymentId,
      paymentAmount: { currency: "USD" as const, minor: 1000n },
      orderId: fixture.order.id,
      externalOrderId: fixture.order.externalOrderId,
      sourceState: {
        refundStatus: staleRefund.status,
        providerWriteState: staleRefund.providerWriteState,
        reversalStatus: staleRefund.reversalStatus,
        succeededMinor: staleRefund.succeededMinor,
        externalRefundReference: staleRefund.externalRefundReference,
        externalSettlementReference: staleRefund.externalSettlementReference,
        nextProviderReconciliationAt: staleRefund.nextProviderReconciliationAt,
        reconciliationLeaseOwner: null,
        reconciliationLeaseExpiresAt: null,
        paymentRefundStatus: fixture.payment.refundStatus,
        paymentRefundedMinor: fixture.payment.refundedMinor,
        orderStatus: fixture.order.status,
      },
    } as Parameters<typeof applyRefundSettlementResultInTransaction>[1];
    const event = {
      type: "refund_succeeded" as const,
      eventId: `evt-refund-lock-order-${round}-${crypto.randomUUID()}`,
      environment: "test" as const,
      externalPaymentId: fixture.payment.externalPaymentId,
      merchantOrderReference: fixture.order.id,
      externalRefundReference: `TKT_CONCURRENT_${round}`,
      amount: { currency: "USD" as const, minor: 1000n },
      occurredAt: new Date(reconciliationAt.getTime() + 1_000),
    };
    const paymentLocked = deferred<void>();
    const releaseWebhook = deferred<void>();
    const reconciliationPid = deferred<number>();

    const webhook = database.db.transaction(async (tx) => {
      await tx.select().from(payments).where(eq(payments.id, fixture.payment.id)).for("update");
      paymentLocked.resolve();
      await releaseWebhook.promise;
      return processProviderEventInTransaction(tx, event, "h".repeat(64));
    });
    await paymentLocked.promise;

    const reconciliation = database.db.transaction(async (tx) => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      reconciliationPid.resolve(Number((backend as { pid: number }).pid));
      await applyRefundSettlementResultInTransaction(
        tx,
        candidate,
        {
          status: "succeeded",
          externalRefundReference: `TKT_CONCURRENT_${round}`,
          externalSettlementReference: `REF_CONCURRENT_${round}`,
          amount: { currency: "USD", minor: 1000n },
        },
        reconciliationAt,
      );
    });

    try {
      await waitForDatabaseLockWait(await reconciliationPid.promise);
      releaseWebhook.resolve();
      await expect(Promise.all([webhook, reconciliation])).resolves.toBeDefined();
    } finally {
      releaseWebhook.resolve();
      await Promise.allSettled([webhook, reconciliation]);
    }

    await processProviderEvent(database.db, event, "h".repeat(64));
    expect(
      await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
    ).toMatchObject({
      status: "succeeded",
      succeededMinor: 1000n,
      externalRefundReference: `TKT_CONCURRENT_${round}`,
    });
    expect(
      await database.db.query.payments.findFirst({ where: eq(payments.id, fixture.payment.id) }),
    ).toMatchObject({ refundStatus: "refunded", refundedMinor: 1000n });
    expect(
      await database.db.query.orders.findFirst({ where: eq(orders.id, fixture.order.id) }),
    ).toMatchObject({ status: "refunded" });
    expect(
      await database.db
        .select()
        .from(fulfillmentJobs)
        .where(eq(fulfillmentJobs.sourceId, fixture.refund.id)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(commerceAppliedEvents)
        .where(eq(commerceAppliedEvents.providerEventId, event.eventId)),
    ).toHaveLength(1);
  }
});

it("lets stale refund reconciliation escalate after provider pending polling", async () => {
  const fixture = await refundCommandFixture(400n);
  const now = new Date("2030-09-17T00:00:00Z");
  const staleUpdatedAt = new Date("2000-01-01T00:00:00Z");
  await database.db
    .update(refunds)
    .set({
      status: "processing",
      reversalStatus: "pending",
      providerWriteState: "dispatched",
      nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
      updatedAt: staleUpdatedAt,
    })
    .where(eq(refunds.id, fixture.refund.id));
  await database.db
    .update(refunds)
    .set({ nextProviderReconciliationAt: null, updatedAt: now })
    .where(ne(refunds.id, fixture.refund.id));

  const provider = refundProvider(
    async () => {
      throw new Error("pending reconciliation must not issue a provider write");
    },
    async () => ({
      status: "found_pending" as const,
      externalRefundReference: "TKT_PENDING_STALE",
    }),
  );

  await expect(reconcileRefundSettlements(database.db, provider, { now, limit: 1 })).resolves.toBe(
    1,
  );
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({ status: "processing", updatedAt: staleUpdatedAt });

  expect(
    await reconcileStaleRefunds(database.db, {
      now: new Date("2030-09-18T00:00:01Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
      limit: 1,
    }),
  ).toBe(1);
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({
    status: "reconciliation_required",
    operatorReviewReason: "provider refund settlement webhook did not arrive within threshold",
  });
});

it("does not retire a pending partial refund after an unrelated partial settlement", async () => {
  const fixture = await refundCommandFixture(400n);
  const otherRefund = await enqueueRefundRequest(database.db, {
    subjectId: fixture.subject.id,
    paymentId: fixture.payment.id,
    environment: "test",
    amount: { currency: "USD", minor: 400n },
    reason: "second partial refund",
    idempotencyKey: `refund:${crypto.randomUUID()}`,
  });
  const now = new Date("2030-09-19T00:00:00Z");
  await database.db
    .update(refunds)
    .set({ nextProviderReconciliationAt: null, updatedAt: now })
    .where(ne(refunds.id, otherRefund.id));
  await database.db
    .update(refunds)
    .set({
      status: "processing",
      reversalStatus: "pending",
      providerWriteState: "dispatched",
      externalRefundReference: "TKT_OTHER_PARTIAL",
      nextProviderReconciliationAt: null,
      updatedAt: now,
    })
    .where(eq(refunds.id, fixture.refund.id));
  await database.db
    .update(refunds)
    .set({
      status: "processing",
      reversalStatus: "pending",
      providerWriteState: "dispatched",
      nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
      updatedAt: now,
    })
    .where(eq(refunds.id, otherRefund.id));

  const readStarted = deferred<void>();
  const releaseRead = deferred<void>();
  const provider = refundProvider(
    async () => {
      throw new Error("partial settlement reconciliation must not issue a provider write");
    },
    async (input) => {
      expect(input.refundIntentReference).toBe(otherRefund.id);
      readStarted.resolve();
      await releaseRead.promise;
      return { status: "not_found" as const };
    },
  );

  const reconciliation = reconcileRefundSettlements(database.db, provider, { now, limit: 1 });
  await readStarted.promise;
  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `evt-refund-unrelated-partial-${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: fixture.payment.externalPaymentId,
      merchantOrderReference: fixture.order.id,
      externalRefundReference: "TKT_OTHER_PARTIAL",
      amount: { currency: "USD", minor: 400n },
      occurredAt: new Date("2030-09-19T00:00:01Z"),
    },
    "g".repeat(64),
  );
  releaseRead.resolve();
  await expect(reconciliation).resolves.toBe(1);

  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, otherRefund.id) }),
  ).toMatchObject({
    status: "processing",
    providerReconciliationAttempts: 0,
    operatorReviewReason: null,
  });
  expect(
    (await database.db.query.refunds.findFirst({ where: eq(refunds.id, otherRefund.id) }))
      ?.nextProviderReconciliationAt,
  ).not.toBeNull();
});

it("does not double-count a provider settlement already projected by a webhook", async () => {
  const fixture = await refundCommandFixture(500n);
  const workerNow = new Date("2030-09-20T00:00:00Z");
  const providerSettlementReference = `REF_PROVIDER_ORIGINATED_${crypto.randomUUID()}`;

  const provider = refundProvider(async () => {
    throw new Error("the initial provider write is intentionally ambiguous");
  });
  await expect(
    runCommerceCommandWorker({
      database: database.db,
      provider,
      owner: `refund-worker-${crypto.randomUUID()}`,
      now: workerNow,
      clock: () => workerNow,
      limit: 1,
    }),
  ).resolves.toBe(0);

  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `evt-provider-originated-${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: fixture.payment.externalPaymentId,
      merchantOrderReference: fixture.order.id,
      externalRefundReference: providerSettlementReference,
      amount: { currency: "USD", minor: 500n },
      occurredAt: new Date(workerNow.getTime() + 1_000),
    },
    "provider-originated-refund".padEnd(64, "0"),
  );
  await database.db
    .update(refunds)
    .set({ nextProviderReconciliationAt: null })
    .where(ne(refunds.id, fixture.refund.id));

  let readCalls = 0;
  const reconciliationProvider = refundProvider(
    async () => {
      throw new Error("scheduled reconciliation must not issue a provider write");
    },
    async () => {
      readCalls += 1;
      return {
        status: "succeeded" as const,
        externalRefundReference: "TKT_ORIGINAL_INTENT",
        externalSettlementReference: providerSettlementReference,
        amount: { currency: "USD" as const, minor: 500n },
      };
    },
  );

  await expect(
    reconcileRefundSettlements(database.db, reconciliationProvider, {
      now: new Date(workerNow.getTime() + 2_000),
      limit: 1,
    }),
  ).resolves.toBe(1);
  expect(readCalls).toBe(1);

  const persistedPayment = await database.db.query.payments.findFirst({
    where: eq(payments.id, fixture.payment.id),
  });
  expect(persistedPayment).toMatchObject({ refundStatus: "partial", refundedMinor: 500n });

  const persistedRefunds = await database.db
    .select()
    .from(refunds)
    .where(eq(refunds.paymentId, fixture.payment.id));
  expect(persistedRefunds).toHaveLength(2);
  expect(persistedRefunds).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: fixture.refund.id,
        status: "reconciliation_required",
        succeededMinor: 0n,
        providerWriteState: "ambiguous",
        operatorReviewReason: "provider settlement already applied by another local refund",
      }),
      expect.objectContaining({
        externalRefundReference: providerSettlementReference,
        status: "succeeded",
        succeededMinor: 500n,
      }),
    ]),
  );
  expect(
    await database.db
      .select()
      .from(fulfillmentJobs)
      .where(eq(fulfillmentJobs.sourceId, fixture.refund.id)),
  ).toHaveLength(0);
});

it("stops automatic refund reads at the reconciliation attempt cap and serves a new candidate", async () => {
  const exhausted = await refundCommandFixture(1000n);
  const now = new Date("2030-10-01T00:00:00Z");
  await database.db
    .update(refunds)
    .set({
      status: "reconciliation_required",
      reversalStatus: "reconciliation_required",
      providerWriteState: "ambiguous",
      providerReconciliationAttempts: 11,
      nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
    })
    .where(eq(refunds.id, exhausted.refund.id));

  const fresh = await refundCommandFixture(1000n);
  await database.db
    .update(refunds)
    .set({
      status: "reconciliation_required",
      reversalStatus: "reconciliation_required",
      providerWriteState: "ambiguous",
      nextProviderReconciliationAt: new Date(now.getTime() + 10 * 60 * 1000),
    })
    .where(eq(refunds.id, fresh.refund.id));
  await database.db
    .update(refunds)
    .set({ nextProviderReconciliationAt: null })
    .where(and(ne(refunds.id, exhausted.refund.id), ne(refunds.id, fresh.refund.id)));

  const readReferences: string[] = [];
  const provider = refundProvider(
    async () => {
      throw new Error("attempt-cap regression must not issue a provider write");
    },
    async (input) => {
      readReferences.push(input.refundIntentReference);
      return { status: "not_found" as const };
    },
  );

  await expect(reconcileRefundSettlements(database.db, provider, { now, limit: 1 })).resolves.toBe(
    1,
  );
  const exhaustedAfter = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, exhausted.refund.id),
  });
  expect(exhaustedAfter).toMatchObject({
    providerReconciliationAttempts: 12,
    nextProviderReconciliationAt: null,
    status: "reconciliation_required",
  });

  await expect(
    reconcileRefundSettlements(database.db, provider, {
      now: new Date(now.getTime() + 10 * 60 * 1000),
      limit: 1,
    }),
  ).resolves.toBe(1);
  expect(readReferences).toEqual([exhausted.refund.id, fresh.refund.id]);
});

it("stops refund lookup work when the runtime signal aborts and does not claim the next candidate", async () => {
  const first = await refundCommandFixture(1000n);
  const second = await refundCommandFixture(1000n);
  const now = new Date("2030-11-01T00:00:00Z");
  for (const fixture of [first, second]) {
    await database.db
      .update(refunds)
      .set({
        status: "processing",
        reversalStatus: "pending",
        providerWriteState: "dispatched",
        nextProviderReconciliationAt: new Date("1900-01-01T00:00:00Z"),
      })
      .where(eq(refunds.id, fixture.refund.id));
  }

  const controller = new AbortController();
  const firstReadStarted = deferred<void>();
  let readCalls = 0;
  let providerReceivedSignal = false;
  const provider = refundProvider(
    async () => {
      throw new Error("runtime-deadline regression must not issue a provider write");
    },
    async (input) => {
      readCalls += 1;
      providerReceivedSignal ||= input.signal === controller.signal;
      if (readCalls === 1) {
        firstReadStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          const rejectOnAbort = () => reject(controller.signal.reason ?? new Error("aborted"));
          if (controller.signal.aborted) rejectOnAbort();
          else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
      }
      return { status: "not_found" as const };
    },
  );

  const reconciliation = reconcileRefundSettlements(database.db, provider, {
    now,
    limit: 2,
    signal: controller.signal,
    canContinue: () => true,
  } as never);
  await firstReadStarted.promise;
  controller.abort(new Error("runtime deadline"));

  await expect(reconciliation).rejects.toThrow("runtime deadline");
  expect(providerReceivedSignal).toBe(true);
  expect(readCalls).toBe(1);
});

it("preserves a legacy unsafe refund and never auto-rebinds it to provider state", async () => {
  const fixture = await refundCommandFixture(1000n);
  await database.db
    .update(refunds)
    .set({
      providerWriteState: "legacy_unsafe",
      status: "pending",
      externalRefundReference: "TKT_LEGACY_UNSAFE",
      updatedAt: new Date("2000-01-01T00:00:00Z"),
    })
    .where(eq(refunds.id, fixture.refund.id));

  let writeCalls = 0;
  let readCalls = 0;
  const provider = refundProvider(
    async () => {
      writeCalls += 1;
      throw new Error("legacy unsafe refund must not POST");
    },
    async () => {
      readCalls += 1;
      throw new Error("legacy unsafe refund must not be read-reconciled");
    },
  );

  await expect(
    reconcileStaleRefunds(database.db, {
      now: new Date("2030-08-01T00:00:00Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
      limit: 10,
    }),
  ).resolves.toBeGreaterThanOrEqual(0);
  await expect(
    runCommerceCommandWorker({
      database: database.db,
      provider,
      owner: `refund-worker-${crypto.randomUUID()}`,
      now: new Date("2030-08-01T00:00:00Z"),
      limit: 1,
    }),
  ).resolves.toBe(1);

  expect(writeCalls).toBe(0);
  expect(readCalls).toBe(0);
  expect(
    await database.db.query.refunds.findFirst({ where: eq(refunds.id, fixture.refund.id) }),
  ).toMatchObject({
    providerWriteState: "legacy_unsafe",
    status: "pending",
    externalRefundReference: "TKT_LEGACY_UNSAFE",
  });
});

it("does not overwrite webhook success when the final provider attempt dead-letters", async () => {
  const race = await startFinalRefundAttempt();
  const deadLetterCountBefore = await securityEventCount("dead_letter_created");
  const webhookOccurredAt = new Date("2031-01-01T00:00:01Z");
  await processProviderEvent(
    database.db,
    {
      type: "refund_succeeded",
      eventId: `evt-final-attempt-success-${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: race.fixture.payment.externalPaymentId,
      amount: { currency: "USD", minor: 1000n },
      occurredAt: webhookOccurredAt,
    },
    "d".repeat(64),
  );
  race.releaseProvider.resolve();

  expect(await race.worker).toBe(0);
  expect(race.calls()).toBe(1);
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, race.fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "succeeded",
    reversalStatus: "pending",
    succeededMinor: 1000n,
    operatorReviewReason: null,
    providerUpdatedAt: webhookOccurredAt,
  });
  const persistedPayment = await database.db.query.payments.findFirst({
    where: eq(payments.id, race.fixture.payment.id),
  });
  expect(persistedPayment).toMatchObject({ refundedMinor: 1000n, refundStatus: "refunded" });
  expect(
    await database.db
      .select()
      .from(commerceReconciliationRuns)
      .where(eq(commerceReconciliationRuns.targetId, race.fixture.payment.id)),
  ).toHaveLength(0);
  await expectFinalAttemptDeadLetter({
    jobId: race.fixture.job.id,
    deadLetterCountBefore,
  });
});

it("does not overwrite webhook failure when the final provider attempt dead-letters", async () => {
  const race = await startFinalRefundAttempt();
  const deadLetterCountBefore = await securityEventCount("dead_letter_created");
  const webhookOccurredAt = new Date("2031-01-01T00:00:02Z");
  await processProviderEvent(
    database.db,
    {
      type: "refund_failed",
      eventId: `evt-final-attempt-failure-${crypto.randomUUID()}`,
      environment: "test",
      externalPaymentId: race.fixture.payment.externalPaymentId,
      occurredAt: webhookOccurredAt,
    },
    "e".repeat(64),
  );
  race.releaseProvider.resolve();

  expect(await race.worker).toBe(0);
  expect(race.calls()).toBe(1);
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, race.fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "failed",
    reversalStatus: "not_required",
    succeededMinor: 0n,
    providerUpdatedAt: webhookOccurredAt,
  });
  const persistedPayment = await database.db.query.payments.findFirst({
    where: eq(payments.id, race.fixture.payment.id),
  });
  expect(persistedPayment?.refundStatus).toBe("failed");
  expect(
    await database.db
      .select()
      .from(commerceReconciliationRuns)
      .where(eq(commerceReconciliationRuns.targetId, race.fixture.payment.id)),
  ).toHaveLength(0);
  await expectFinalAttemptDeadLetter({
    jobId: race.fixture.job.id,
    deadLetterCountBefore,
  });
});

it("does not overwrite stale reconciliation when the final provider attempt dead-letters", async () => {
  const race = await startFinalRefundAttempt();
  const deadLetterCountBefore = await securityEventCount("dead_letter_created");
  await database.db
    .update(refunds)
    .set({ updatedAt: new Date("2000-01-01T00:00:00Z") })
    .where(eq(refunds.id, race.fixture.refund.id));
  expect(
    await reconcileStaleRefunds(database.db, {
      now: new Date("2031-01-03T00:00:00Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
      limit: 1,
    }),
  ).toBe(1);
  race.releaseProvider.resolve();

  expect(await race.worker).toBe(0);
  expect(race.calls()).toBe(1);
  const persistedRefund = await database.db.query.refunds.findFirst({
    where: eq(refunds.id, race.fixture.refund.id),
  });
  expect(persistedRefund).toMatchObject({
    status: "reconciliation_required",
    reversalStatus: "reconciliation_required",
    operatorReviewReason: "provider refund settlement webhook did not arrive within threshold",
    externalRefundReference: null,
  });
  const reconciliations = await database.db
    .select()
    .from(commerceReconciliationRuns)
    .where(eq(commerceReconciliationRuns.targetId, race.fixture.payment.id));
  expect(reconciliations).toHaveLength(1);
  expect(reconciliations[0]?.afterJson).toMatchObject({
    status: "reconciliation_required",
    reason: "provider_settlement_timeout",
  });
  await expectFinalAttemptDeadLetter({
    jobId: race.fixture.job.id,
    deadLetterCountBefore,
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
