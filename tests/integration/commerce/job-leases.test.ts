import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  claimCommerceCommandJobs,
  claimFulfillmentJobs,
  claimWebhookInbox,
} from "@/platform/commerce/application/job-leases";
import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import type { OrderFulfillment } from "@/platform/commerce/application/order-fulfillment";
import { runCommerceCommandWorker } from "@/platform/commerce/application/run-commerce-command-worker";
import { runCommerceWorker } from "@/platform/commerce/application/run-commerce-worker";
import { runFulfillmentWorker } from "@/platform/commerce/application/run-fulfillment-worker";
import { runWebhookInboxWorker } from "@/platform/commerce/application/run-webhook-inbox-worker";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  authSecurityEvents,
  commerceCommandJobs,
  commerceProducts,
  fulfillmentJobs,
  orders,
  paymentWebhookInbox,
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

beforeEach(async () => {
  await database.db.delete(commerceCommandJobs);
  await database.db.delete(fulfillmentJobs);
  await database.db.delete(paymentWebhookInbox);
  await database.db.delete(authSecurityEvents);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

async function waitForLeaseOwner(
  load: () => Promise<{ readonly leaseOwner: string | null } | undefined>,
  owner: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await load())?.leaseOwner === owner) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`lease was not claimed by ${owner}`);
}

async function securityEventCount(eventType: string): Promise<number> {
  const [row] = await database.db
    .select({ count: sql<number>`count(*)::int` })
    .from(authSecurityEvents)
    .where(eq(authSecurityEvents.eventType, eventType));
  return row?.count ?? 0;
}

async function seedOrder(model: "one_time" | "subscription", expectedMinor = 1000n) {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const externalOrderId = `${model === "one_time" ? "ORD" : "SUB"}_${crypto.randomUUID()}`;
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `lease-${model}-${crypto.randomUUID()}`,
      version: 1,
      model,
      billingInterval: model === "subscription" ? "month" : null,
      environment: "test",
      providerProductId: `PROD_${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor,
      fulfillmentKey: "lease-test",
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
      expectedMinor,
      checkoutIdempotencyKey: `checkout:${crypto.randomUUID()}`,
      checkoutState: "created",
      externalOrderId,
    })
    .returning();
  if (!order) throw new Error("order insert failed");
  return { subject, order, externalOrderId };
}

async function seedWebhookJob(input: {
  readonly now: Date;
  readonly amountMinor?: bigint;
  readonly attempts?: number;
}) {
  const fixture = await seedOrder("one_time");
  const eventId = `lease-event-${crypto.randomUUID()}`;
  const [job] = await database.db
    .insert(paymentWebhookInbox)
    .values({
      environment: "test",
      providerEventId: eventId,
      dedupHash: crypto.randomUUID().replaceAll("-", ""),
      eventType: "one_time_payment_succeeded",
      signatureValid: true,
      normalizedPayloadJson: {
        type: "one_time_payment_succeeded",
        eventId,
        environment: "test",
        externalOrderId: fixture.externalOrderId,
        merchantOrderReference: fixture.order.id,
        externalPaymentId: `PAY_${crypto.randomUUID()}`,
        amount: { currency: "USD", minor: String(input.amountMinor ?? 1000n) },
        occurredAt: input.now.toISOString(),
      },
      payloadHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      payloadSizeBytes: 128,
      retentionClass: "normalized_only",
      attempts: input.attempts ?? 0,
      nextAttemptAt: input.now,
      receivedAt: input.now,
    })
    .returning();
  if (!job) throw new Error("webhook job insert failed");
  return { ...fixture, job };
}

async function holdOrderLock(orderId: string) {
  const acquired = deferred<void>();
  const release = deferred<void>();
  const transaction = database.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (!locked) throw new Error("order lock fixture missing");
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;
  return { release, transaction };
}

async function seedCommandJob(input: { readonly now: Date; readonly attempts?: number }) {
  const fixture = await seedOrder("subscription");
  const [subscription] = await database.db
    .insert(subscriptions)
    .values({
      orderId: fixture.order.id,
      subjectId: fixture.subject.id,
      environment: "test",
      externalOrderId: fixture.externalOrderId,
      status: "active",
    })
    .returning();
  if (!subscription) throw new Error("subscription insert failed");
  const [job] = await database.db
    .insert(commerceCommandJobs)
    .values({
      subjectId: fixture.subject.id,
      commandType: "subscription_cancel",
      targetId: subscription.id,
      idempotencyKey: `cancel:${crypto.randomUUID()}`,
      attempts: input.attempts ?? 0,
      nextAttemptAt: input.now,
    })
    .returning();
  if (!job) throw new Error("command job insert failed");
  return { ...fixture, subscription, job };
}

function paymentProvider(
  cancelSubscription: PaymentProvider["cancelSubscription"],
): PaymentProvider {
  return {
    name: "lease-test-provider",
    capabilities: { oneTime: true, subscriptions: true, partialRefunds: true },
    async createCheckout() {
      throw new Error("not used");
    },
    async createOneTimeCheckout() {
      throw new Error("not used");
    },
    cancelSubscription,
    async resumeSubscription() {
      throw new Error("not used");
    },
    async requestRefund() {
      throw new Error("not used");
    },
    async getPayment() {
      return null;
    },
    async verifyAndNormalizeWebhook() {
      throw new Error("not used");
    },
  };
}

async function seedFulfillmentJob(input: { readonly now: Date; readonly attempts?: number }) {
  const [job] = await database.db
    .insert(fulfillmentJobs)
    .values({
      sourceType: "payment",
      sourceId: `PAY_${crypto.randomUUID()}`,
      operation: "fulfill:lease-test",
      idempotencyKey: `fulfill:${crypto.randomUUID()}`,
      attempts: input.attempts ?? 0,
      nextAttemptAt: input.now,
    })
    .returning();
  if (!job) throw new Error("fulfillment job insert failed");
  return job;
}

it("reclaims expired processing webhook leases but not active leases", async () => {
  const now = new Date("2026-08-08T04:00:00Z");
  const [expired] = await database.db
    .insert(paymentWebhookInbox)
    .values({
      environment: "test",
      providerEventId: `expired-${crypto.randomUUID()}`,
      dedupHash: crypto.randomUUID().replaceAll("-", ""),
      eventType: "one_time_payment_succeeded",
      signatureValid: true,
      normalizedPayloadJson: {},
      payloadHash: "a".repeat(64),
      payloadSizeBytes: 1,
      retentionClass: "normalized_only",
      state: "processing",
      leaseOwner: "crashed-worker",
      leaseExpiresAt: new Date(now.getTime() - 1),
      nextAttemptAt: new Date(now.getTime() - 1),
    })
    .returning();
  const [active] = await database.db
    .insert(paymentWebhookInbox)
    .values({
      environment: "test",
      providerEventId: `active-${crypto.randomUUID()}`,
      dedupHash: crypto.randomUUID().replaceAll("-", ""),
      eventType: "one_time_payment_succeeded",
      signatureValid: true,
      normalizedPayloadJson: {},
      payloadHash: "b".repeat(64),
      payloadSizeBytes: 1,
      retentionClass: "normalized_only",
      state: "processing",
      leaseOwner: "live-worker",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      nextAttemptAt: new Date(now.getTime() - 1),
    })
    .returning();
  if (!expired || !active) throw new Error("fixture insert failed");

  const claimed = await claimWebhookInbox(database.db, { owner: "recovery-worker", now });
  expect(claimed.map((row) => row.id)).toContain(expired.id);
  expect(claimed.map((row) => row.id)).not.toContain(active.id);

  const recovered = await database.db.query.paymentWebhookInbox.findFirst({
    where: eq(paymentWebhookInbox.id, expired.id),
  });
  expect(recovered?.leaseOwner).toBe("recovery-worker");
});

it("reclaims expired processing fulfillment leases but not active leases", async () => {
  const now = new Date("2026-08-08T05:00:00Z");
  const [expired] = await database.db
    .insert(fulfillmentJobs)
    .values({
      sourceType: "payment",
      sourceId: `expired-${crypto.randomUUID()}`,
      operation: "fulfill:test",
      idempotencyKey: `expired-${crypto.randomUUID()}`,
      state: "processing",
      leaseOwner: "crashed-worker",
      leaseExpiresAt: new Date(now.getTime() - 1),
      nextAttemptAt: new Date(now.getTime() - 1),
    })
    .returning();
  const [active] = await database.db
    .insert(fulfillmentJobs)
    .values({
      sourceType: "payment",
      sourceId: `active-${crypto.randomUUID()}`,
      operation: "fulfill:test",
      idempotencyKey: `active-${crypto.randomUUID()}`,
      state: "processing",
      leaseOwner: "live-worker",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      nextAttemptAt: new Date(now.getTime() - 1),
    })
    .returning();
  if (!expired || !active) throw new Error("fixture insert failed");

  const claimed = await claimFulfillmentJobs(database.db, { owner: "recovery-worker", now });
  expect(claimed.map((row) => row.id)).toContain(expired.id);
  expect(claimed.map((row) => row.id)).not.toContain(active.id);

  const recovered = await database.db.query.fulfillmentJobs.findFirst({
    where: eq(fulfillmentJobs.id, expired.id),
  });
  expect(recovered?.leaseOwner).toBe("recovery-worker");
});

it("reclaims expired subscription/refund command leases but not active leases", async () => {
  const now = new Date("2026-08-09T05:00:00Z");
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");

  const [expired] = await database.db
    .insert(commerceCommandJobs)
    .values({
      subjectId: subject.id,
      commandType: "subscription_cancel",
      targetId: crypto.randomUUID(),
      idempotencyKey: `expired:${crypto.randomUUID()}`,
      state: "processing",
      leaseOwner: "crashed-worker",
      leaseExpiresAt: new Date(now.getTime() - 1),
      nextAttemptAt: new Date(now.getTime() - 1),
    })
    .returning();
  const [active] = await database.db
    .insert(commerceCommandJobs)
    .values({
      subjectId: subject.id,
      commandType: "refund_request",
      targetId: crypto.randomUUID(),
      idempotencyKey: `active:${crypto.randomUUID()}`,
      state: "processing",
      leaseOwner: "live-worker",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      nextAttemptAt: new Date(now.getTime() - 1),
    })
    .returning();
  if (!expired || !active) throw new Error("command fixture insert failed");

  const claimed = await claimCommerceCommandJobs(database.db, {
    owner: "recovery-worker",
    now,
  });
  expect(claimed.map((row) => row.id)).toContain(expired.id);
  expect(claimed.map((row) => row.id)).not.toContain(active.id);

  const recovered = await database.db.query.commerceCommandJobs.findFirst({
    where: eq(commerceCommandJobs.id, expired.id),
  });
  expect(recovered?.leaseOwner).toBe("recovery-worker");
});

it("two workers claim disjoint webhook batches without duplicate ownership", async () => {
  const now = new Date("2026-08-09T06:00:00Z");
  const prefix = `concurrent-${crypto.randomUUID()}`;
  await database.db.insert(paymentWebhookInbox).values(
    Array.from({ length: 12 }, (_, index) => ({
      environment: "test",
      providerEventId: `${prefix}-${index}`,
      dedupHash: crypto.randomUUID().replaceAll("-", ""),
      eventType: "one_time_payment_succeeded",
      signatureValid: true,
      normalizedPayloadJson: {},
      payloadHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      payloadSizeBytes: 1,
      retentionClass: "normalized_only",
      state: "pending" as const,
      nextAttemptAt: new Date(now.getTime() - 1),
      receivedAt: now,
    })),
  );

  const [workerA, workerB] = await Promise.all([
    claimWebhookInbox(database.db, { owner: "worker-a", now, limit: 6 }),
    claimWebhookInbox(database.db, { owner: "worker-b", now, limit: 6 }),
  ]);

  const idsA = new Set(
    workerA.filter((row) => row.providerEventId.startsWith(prefix)).map((row) => row.id),
  );
  const idsB = new Set(
    workerB.filter((row) => row.providerEventId.startsWith(prefix)).map((row) => row.id),
  );
  expect(idsA.size).toBe(6);
  expect(idsB.size).toBe(6);
  expect([...idsA].filter((id) => idsB.has(id))).toEqual([]);
  expect(new Set([...idsA, ...idsB]).size).toBe(12);
});

it("does not let a stale webhook worker acknowledge a lease reclaimed by a new owner", async () => {
  const now = new Date("2040-01-01T00:00:00Z");
  const fixture = await seedWebhookJob({ now });
  const lock = await holdOrderLock(fixture.order.id);
  const worker = runWebhookInboxWorker({
    database: database.db,
    owner: "webhook-old-owner",
    now,
    limit: 1,
  });
  await waitForLeaseOwner(
    () =>
      database.db.query.paymentWebhookInbox.findFirst({
        where: eq(paymentWebhookInbox.id, fixture.job.id),
      }),
    "webhook-old-owner",
  );

  const reclaimed = await claimWebhookInbox(database.db, {
    owner: "webhook-new-owner",
    now: new Date(now.getTime() + 6 * 60 * 1000),
    limit: 1,
  });
  expect(reclaimed.map((row) => row.id)).toEqual([fixture.job.id]);
  lock.release.resolve();
  await lock.transaction;

  expect(await worker).toEqual({ claimed: 1, processed: 0 });
  const persisted = await database.db.query.paymentWebhookInbox.findFirst({
    where: eq(paymentWebhookInbox.id, fixture.job.id),
  });
  expect(persisted).toMatchObject({
    state: "processing",
    attempts: 0,
    leaseOwner: "webhook-new-owner",
  });
});

it("does not let an expired webhook lease nack or dead-letter the job", async () => {
  const now = new Date("2040-02-01T00:00:00Z");
  const fixture = await seedWebhookJob({ now, amountMinor: 999n, attempts: 11 });
  const lock = await holdOrderLock(fixture.order.id);
  const worker = runWebhookInboxWorker({
    database: database.db,
    owner: "webhook-expired-owner",
    now,
    limit: 1,
  });
  await waitForLeaseOwner(
    () =>
      database.db.query.paymentWebhookInbox.findFirst({
        where: eq(paymentWebhookInbox.id, fixture.job.id),
      }),
    "webhook-expired-owner",
  );
  await database.db
    .update(paymentWebhookInbox)
    .set({ leaseExpiresAt: new Date(now.getTime() - 1) })
    .where(eq(paymentWebhookInbox.id, fixture.job.id));
  lock.release.resolve();
  await lock.transaction;

  expect(await worker).toEqual({ claimed: 1, processed: 0 });
  const persisted = await database.db.query.paymentWebhookInbox.findFirst({
    where: eq(paymentWebhookInbox.id, fixture.job.id),
  });
  expect(persisted).toMatchObject({
    state: "processing",
    attempts: 11,
    leaseOwner: "webhook-expired-owner",
    lastErrorCode: null,
  });
  expect(await securityEventCount("dead_letter_created")).toBe(0);
});

it("does not let a stale command worker acknowledge a lease reclaimed during provider I/O", async () => {
  const now = new Date("2040-03-01T00:00:00Z");
  const fixture = await seedCommandJob({ now });
  const providerCalled = deferred<void>();
  const releaseProvider = deferred<void>();
  const provider = paymentProvider(async () => {
    providerCalled.resolve();
    await releaseProvider.promise;
    return { externalOrderId: fixture.externalOrderId, status: "canceling" };
  });
  const worker = runCommerceCommandWorker({
    database: database.db,
    provider,
    owner: "command-old-owner",
    now,
    limit: 1,
  });
  await providerCalled.promise;

  const reclaimed = await claimCommerceCommandJobs(database.db, {
    owner: "command-new-owner",
    now: new Date(now.getTime() + 6 * 60 * 1000),
    limit: 1,
  });
  expect(reclaimed.map((row) => row.id)).toEqual([fixture.job.id]);
  releaseProvider.resolve();

  expect(await worker).toBe(0);
  const persisted = await database.db.query.commerceCommandJobs.findFirst({
    where: eq(commerceCommandJobs.id, fixture.job.id),
  });
  expect(persisted).toMatchObject({
    state: "processing",
    attempts: 0,
    leaseOwner: "command-new-owner",
  });
});

it("does not let an expired command lease nack, dead-letter, or emit failure side effects", async () => {
  const now = new Date("2040-04-01T00:00:00Z");
  const fixture = await seedCommandJob({ now, attempts: 11 });
  const providerCalled = deferred<void>();
  const releaseProvider = deferred<void>();
  const provider = paymentProvider(async () => {
    providerCalled.resolve();
    await releaseProvider.promise;
    throw new Error("provider unavailable");
  });
  const worker = runCommerceCommandWorker({
    database: database.db,
    provider,
    owner: "command-expired-owner",
    now,
    limit: 1,
  });
  await providerCalled.promise;
  await database.db
    .update(commerceCommandJobs)
    .set({ leaseExpiresAt: new Date(now.getTime() - 1) })
    .where(eq(commerceCommandJobs.id, fixture.job.id));
  releaseProvider.resolve();

  expect(await worker).toBe(0);
  const persisted = await database.db.query.commerceCommandJobs.findFirst({
    where: eq(commerceCommandJobs.id, fixture.job.id),
  });
  expect(persisted).toMatchObject({
    state: "processing",
    attempts: 11,
    leaseOwner: "command-expired-owner",
    lastErrorCode: null,
  });
  expect(await securityEventCount("provider_failure")).toBe(0);
  expect(await securityEventCount("dead_letter_created")).toBe(0);
});

it("does not let a stale fulfillment worker acknowledge a lease reclaimed by a new owner", async () => {
  const now = new Date("2040-05-01T00:00:00Z");
  const job = await seedFulfillmentJob({ now });
  const fulfillmentCalled = deferred<void>();
  const releaseFulfillment = deferred<void>();
  const fulfillment: OrderFulfillment = {
    async fulfill() {
      fulfillmentCalled.resolve();
      await releaseFulfillment.promise;
    },
  };
  const worker = runFulfillmentWorker({
    database: database.db,
    fulfillment,
    owner: "fulfillment-old-owner",
    now,
    limit: 1,
  });
  await fulfillmentCalled.promise;

  const reclaimed = await claimFulfillmentJobs(database.db, {
    owner: "fulfillment-new-owner",
    now: new Date(now.getTime() + 6 * 60 * 1000),
    limit: 1,
  });
  expect(reclaimed.map((row) => row.id)).toEqual([job.id]);
  releaseFulfillment.resolve();

  expect(await worker).toEqual({ claimed: 1, processed: 0 });
  const persisted = await database.db.query.fulfillmentJobs.findFirst({
    where: eq(fulfillmentJobs.id, job.id),
  });
  expect(persisted).toMatchObject({
    state: "processing",
    attempts: 0,
    leaseOwner: "fulfillment-new-owner",
  });
});

it("does not let an expired fulfillment lease nack or dead-letter the job", async () => {
  const now = new Date("2040-06-01T00:00:00Z");
  const job = await seedFulfillmentJob({ now, attempts: 11 });
  const fulfillmentCalled = deferred<void>();
  const releaseFulfillment = deferred<void>();
  const fulfillment: OrderFulfillment = {
    async fulfill() {
      fulfillmentCalled.resolve();
      await releaseFulfillment.promise;
      throw new Error("fulfillment unavailable");
    },
  };
  const worker = runFulfillmentWorker({
    database: database.db,
    fulfillment,
    owner: "fulfillment-expired-owner",
    now,
    limit: 1,
  });
  await fulfillmentCalled.promise;
  await database.db
    .update(fulfillmentJobs)
    .set({ leaseExpiresAt: new Date(now.getTime() - 1) })
    .where(eq(fulfillmentJobs.id, job.id));
  releaseFulfillment.resolve();

  expect(await worker).toEqual({ claimed: 1, processed: 0 });
  const persisted = await database.db.query.fulfillmentJobs.findFirst({
    where: eq(fulfillmentJobs.id, job.id),
  });
  expect(persisted).toMatchObject({
    state: "processing",
    attempts: 11,
    leaseOwner: "fulfillment-expired-owner",
    lastErrorCode: null,
  });
  expect(await securityEventCount("dead_letter_created")).toBe(0);
});

it("reserves aggregate capacity for every queue and reports actual claims", async () => {
  const now = new Date("2040-07-01T00:00:00Z");
  const prefix = `fairness-${crypto.randomUUID()}`;
  const inbox = await database.db
    .insert(paymentWebhookInbox)
    .values(
      Array.from({ length: 6 }, (_, index) => ({
        environment: "test",
        providerEventId: `${prefix}-${index}`,
        dedupHash: crypto.randomUUID().replaceAll("-", ""),
        eventType: "unsupported",
        signatureValid: true,
        normalizedPayloadJson: {},
        payloadHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
        payloadSizeBytes: 1,
        retentionClass: "normalized_only",
        nextAttemptAt: now,
        receivedAt: new Date(now.getTime() + index),
      })),
    )
    .returning();
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("fairness subject insert failed");
  const [command] = await database.db
    .insert(commerceCommandJobs)
    .values({
      subjectId: subject.id,
      commandType: "subscription_cancel",
      targetId: crypto.randomUUID(),
      idempotencyKey: `fairness:${crypto.randomUUID()}`,
      nextAttemptAt: now,
    })
    .returning();
  const fulfillment = await seedFulfillmentJob({ now });
  if (!command) throw new Error("fairness command insert failed");
  let fulfillmentCalls = 0;
  let claimed = -1;

  const result = await runCommerceWorker({
    database: database.db,
    provider: paymentProvider(async () => {
      throw new Error("provider must not be called for a missing target");
    }),
    fulfillment: {
      async fulfill() {
        fulfillmentCalls += 1;
      },
    },
    owner: "fairness-worker",
    now,
    limit: 4,
    onClaimed(count) {
      claimed = count;
    },
  });

  expect(result).toEqual({
    inboxProcessed: 0,
    commandProcessed: 0,
    fulfillmentProcessed: 1,
  });
  expect(claimed).toBe(3);
  expect(fulfillmentCalls).toBe(1);
  const inboxRows = await database.db
    .select()
    .from(paymentWebhookInbox)
    .where(
      inArray(
        paymentWebhookInbox.id,
        inbox.map((row) => row.id),
      ),
    );
  expect(inboxRows.filter((row) => row.state === "retry")).toHaveLength(1);
  expect(inboxRows.filter((row) => row.state === "pending")).toHaveLength(5);
  const persistedCommand = await database.db.query.commerceCommandJobs.findFirst({
    where: eq(commerceCommandJobs.id, command.id),
  });
  expect(persistedCommand).toMatchObject({ state: "pending", attempts: 1 });
  const persistedFulfillment = await database.db.query.fulfillmentJobs.findFirst({
    where: eq(fulfillmentJobs.id, fulfillment.id),
  });
  expect(persistedFulfillment).toMatchObject({ state: "completed", attempts: 0 });
});
