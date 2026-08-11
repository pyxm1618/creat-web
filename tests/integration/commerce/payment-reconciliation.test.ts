import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { ProviderContractError } from "@/platform/commerce/application/errors";
import {
  claimPaymentReconciliationJobs,
  completePaymentReconciliationJob,
  operatorReviewPaymentReconciliationJob,
  retryPaymentReconciliationJob,
} from "@/platform/commerce/application/job-leases";
import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import { processProviderEvent } from "@/platform/commerce/application/process-provider-event";
import {
  reconcileStalePayments,
  seedPaymentReconciliationJobs,
} from "@/platform/commerce/application/reconcile-stale-payments";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceAppliedEvents,
  commerceReconciliationRuns,
  commerceProducts,
  creditGrants,
  creditLedgerEntries,
  fulfillmentJobs,
  orders,
  paymentReconciliationJobs,
  payments,
  subscriptionPeriods,
  subscriptions,
} from "@/platform/database/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabaseClient(databaseUrl);

const invalidWarningCases = [
  [
    "too many warnings",
    Array.from({ length: 17 }, (_, index) => ({
      message: `warning-${index}`,
      layer: "payments",
    })),
  ],
  ["message too long", [{ message: "m".repeat(513), layer: "payments" }]],
  ["layer too long", [{ message: "warning", layer: "l".repeat(65) }]],
  ["AI hint too long", [{ message: "warning", layer: "payments", aiHint: "a".repeat(513) }]],
] as const;

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
  await database.db.delete(subscriptionPeriods);
  await database.db.delete(subscriptions);
  await database.db.delete(creditLedgerEntries);
  await database.db.delete(creditGrants);
  await database.db.delete(orders);
  await database.db.delete(commerceProducts);
  await database.db.delete(accountSubjects);
});

function paymentProvider(getPayment: PaymentProvider["getPayment"]): PaymentProvider {
  const unsupported = async () => {
    throw new Error("unexpected provider operation");
  };
  return {
    name: "reconciliation-test-provider",
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

async function seedOrder(input: { readonly model?: "one_time" | "subscription" } = {}) {
  const model = input.model ?? "one_time";
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `payment-reconciliation-${crypto.randomUUID()}`,
      version: 1,
      model,
      ...(model === "subscription" ? { billingInterval: "month" } : {}),
      environment: "test",
      providerProductId: `PROD_${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor: 2900n,
      fulfillmentKey: "payment-reconciliation",
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
    })
    .returning();
  if (!order) throw new Error("order insert failed");
  return order;
}

it("installs the durable payment reconciliation job columns", async () => {
  const rows = await database.db.execute(sql<{ column_name: string }>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payment_reconciliation_jobs'
    order by ordinal_position
  `);

  expect(rows.map((row) => row.column_name)).toEqual([
    "id",
    "order_id",
    "state",
    "attempts",
    "lease_owner",
    "lease_token",
    "lease_expires_at",
    "next_attempt_at",
    "last_error_code",
    "operator_review_reason",
    "created_at",
    "updated_at",
    "completed_at",
  ]);
});

it("derives reconciliation environment from the referenced order", () => {
  type JobInsert = typeof paymentReconciliationJobs.$inferInsert;
  const environmentIsNotInsertable: "environment" extends keyof JobInsert ? never : true = true;
  expect(environmentIsNotInsertable).toBe(true);
});

it("installs fail-closed state, lease, and operator-review constraints", async () => {
  const rows = await database.db.execute(sql<{ name: string; definition: string }>`
    select constraint_name as name, pg_get_constraintdef(pc.oid) as definition
    from information_schema.table_constraints tc
    join pg_constraint pc on pc.conname = tc.constraint_name
    where tc.table_schema = 'public'
      and tc.table_name = 'payment_reconciliation_jobs'
  `);
  const constraints = new Map(rows.map((row) => [row.name, row.definition]));

  expect(constraints.get("payment_reconciliation_job_state_valid")).toContain("operator_review");
  expect(constraints.get("payment_reconciliation_job_attempts_valid")).toContain(">= 0");
  expect(constraints.get("payment_reconciliation_job_attempts_valid")).toContain("<= 12");
  expect(constraints.get("payment_reconciliation_job_attempts_valid")).toContain("dead_letter");
  expect(constraints.get("payment_reconciliation_job_lease_consistent")).toContain("lease_token");
  expect(constraints.get("payment_reconciliation_job_review_reason_consistent")).toContain(
    "operator_review_reason",
  );
});

it("installs due, reclaim, and per-order idempotency indexes", async () => {
  const rows = await database.db.execute(sql<{ name: string; definition: string }>`
    select indexname as name, indexdef as definition
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'payment_reconciliation_jobs'
  `);
  const indexes = new Map(rows.map((row) => [row.name, row.definition]));

  expect(indexes.get("payment_reconciliation_order_uq")).toMatch(/\(order_id\)$/);
  expect(indexes.get("payment_reconciliation_order_uq")).not.toContain("environment");
  expect(indexes.get("payment_reconciliation_due_idx")).toContain(
    "state, next_attempt_at, created_at",
  );
  expect(indexes.get("payment_reconciliation_reclaim_idx")).toContain("state, lease_expires_at");
});

it("uses a partial created-at index for stale pending checkout seeds", async () => {
  const rows = await database.db.execute(sql<{ definition: string }>`
    select indexdef as definition
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'orders'
      and indexname = 'order_payment_reconciliation_stale_idx'
  `);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.definition).toContain("(created_at, id)");
  expect(rows[0]?.definition).toContain(
    "WHERE ((checkout_state = 'created'::text) AND (status = 'pending'::text))",
  );

  const plan = await database.db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local enable_seqscan = off"));
    const explained = await tx.execute(sql<Record<string, unknown>>`
      explain (costs off)
      select id
      from orders
      where checkout_state = 'created'
        and status = 'pending'
        and created_at <= timestamp with time zone '2030-05-01T00:00:00.000Z'
      order by created_at, id
      limit 100
    `);
    return explained.map((row) => String(Object.values(row)[0])).join("\n");
  });
  expect(plan).toContain("order_payment_reconciliation_stale_idx");
});

it("seeds only stale created pending orders with derived product facts exactly once", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const staleAt = new Date("2030-04-30T00:00:00.000Z");
  const freshAt = new Date("2030-05-01T12:00:00.000Z");
  const staleAfterMs = 24 * 60 * 60 * 1000;
  const eligible = await seedOrder();
  const fresh = await seedOrder();
  const paid = await seedOrder();
  const failedCheckout = await seedOrder();

  await Promise.all([
    database.db.update(orders).set({ createdAt: staleAt }).where(eq(orders.id, eligible.id)),
    database.db.update(orders).set({ createdAt: freshAt }).where(eq(orders.id, fresh.id)),
    database.db
      .update(orders)
      .set({ createdAt: staleAt, status: "paid" })
      .where(eq(orders.id, paid.id)),
    database.db
      .update(orders)
      .set({ createdAt: staleAt, checkoutState: "failed" })
      .where(eq(orders.id, failedCheckout.id)),
  ]);

  const first = await seedPaymentReconciliationJobs(database.db, {
    now,
    staleAfterMs,
    limit: 20,
  });
  const replay = await seedPaymentReconciliationJobs(database.db, {
    now,
    staleAfterMs,
    limit: 20,
  });

  expect(first).toEqual({
    scanned: 1,
    seeded: 1,
    jobs: [
      {
        orderId: eligible.id,
        environment: "test",
        externalOrderId: eligible.externalOrderId,
        model: "one_time",
        currency: "USD",
        amountMinor: 2900n,
        fulfillmentKey: "payment-reconciliation",
      },
    ],
  });
  expect(replay).toEqual({ scanned: 0, seeded: 0, jobs: [] });

  const jobs = await database.db.select().from(paymentReconciliationJobs);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.orderId).toBe(eligible.id);
});

it("does not hold an order row lock while a reconciliation job insert is blocked", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  let markTableLocked!: () => void;
  let releaseTable!: () => void;
  const tableLocked = new Promise<void>((resolve) => {
    markTableLocked = resolve;
  });
  const tableRelease = new Promise<void>((resolve) => {
    releaseTable = resolve;
  });
  const blocker = database.db.transaction(async (tx) => {
    await tx.execute(sql.raw("lock table payment_reconciliation_jobs in access exclusive mode"));
    markTableLocked();
    await tableRelease;
  });
  await tableLocked;
  const seeding = seedPaymentReconciliationJobs(database.db, {
    now,
    staleAfterMs: 24 * 60 * 60 * 1000,
  });

  let jobQueryBlocked = false;
  for (let attempt = 0; attempt < 50 && !jobQueryBlocked; attempt += 1) {
    const rows = await database.db.execute(sql<{ blocked: boolean }>`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query like '%payment_reconciliation_jobs%'
          and query not like '%pg_stat_activity%'
      ) as blocked
    `);
    jobQueryBlocked = Boolean(rows[0]?.blocked);
    if (!jobQueryBlocked) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  let orderLockError: unknown;
  try {
    await database.db.transaction(async (tx) => {
      await tx.execute(sql.raw("set local statement_timeout = '250ms'"));
      await tx.select().from(orders).where(eq(orders.id, order.id)).for("update");
    });
  } catch (error) {
    orderLockError = error;
  } finally {
    releaseTable();
    await blocker;
    await seeding;
  }

  expect(jobQueryBlocked).toBe(true);
  expect(orderLockError).toBeUndefined();
});

it("does not let older terminal jobs consume the seeding limit", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const older = await seedOrder();
  const unseeded = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-29T00:00:00.000Z") })
    .where(eq(orders.id, older.id));
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, unseeded.id));
  await database.db.insert(paymentReconciliationJobs).values({
    orderId: older.id,
    state: "completed",
    completedAt: new Date("2030-05-01T00:00:00.000Z"),
  });

  expect(
    await seedPaymentReconciliationJobs(database.db, {
      now,
      staleAfterMs: 24 * 60 * 60 * 1000,
      limit: 1,
    }),
  ).toEqual({
    scanned: 1,
    seeded: 1,
    jobs: [
      {
        orderId: unseeded.id,
        environment: "test",
        externalOrderId: unseeded.externalOrderId,
        model: "one_time",
        currency: "USD",
        amountMinor: 2900n,
        fulfillmentKey: "payment-reconciliation",
      },
    ],
  });
});

it("applies one recovered one-time success exactly once across a replay", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const externalPaymentId = `PAY_${crypto.randomUUID()}`;
  const lookup = vi.fn<PaymentProvider["getPayment"]>().mockResolvedValue({
    payments: [
      {
        environment: "test",
        model: "one_time",
        storeId: "STORE_TEST",
        externalOrderId: order.externalOrderId!,
        merchantOrderReference: order.id,
        externalPaymentId,
        status: "succeeded",
        amount: { currency: "USD", minor: 2900n },
        occurredAt: new Date("2030-05-01T23:59:00.000Z"),
      },
    ],
    warnings: [],
  });
  const provider = paymentProvider(lookup);
  const run = () =>
    reconcileStalePayments(database.db, provider, {
      owner: "payment-reconciliation-worker",
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
      limit: 10,
    });

  expect(await run()).toEqual({ scanned: 1, applied: 1, retried: 0, operatorReview: 0 });
  expect(await run()).toEqual({ scanned: 0, applied: 0, retried: 0, operatorReview: 0 });

  const persistedOrder = await database.db.query.orders.findFirst({
    where: eq(orders.id, order.id),
  });
  expect(persistedOrder).toMatchObject({
    status: "paid",
    paidAt: new Date("2030-05-01T23:59:00.000Z"),
  });
  expect(
    await database.db
      .select()
      .from(payments)
      .where(
        and(eq(payments.environment, "test"), eq(payments.externalPaymentId, externalPaymentId)),
      ),
  ).toHaveLength(1);
  expect(
    await database.db
      .select()
      .from(fulfillmentJobs)
      .where(eq(fulfillmentJobs.sourceId, externalPaymentId)),
  ).toHaveLength(1);
  const applications = await database.db.select().from(commerceAppliedEvents);
  expect(applications).toHaveLength(1);
  expect(applications[0]?.providerEventId).toBe(
    `payment-reconciliation:test:${externalPaymentId}:succeeded`,
  );
  expect(applications[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
    { orderId: order.id, state: "completed" },
  ]);
  expect(lookup).toHaveBeenCalledTimes(1);
});

it("durably audits allowlisted provider warnings on a successful recovery", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const warning = {
    message: "provider result used a compatibility field",
    layer: "payments",
    aiHint: "verify provider rollout",
    secretInternalDetail: "must not persist",
  };
  const provider = paymentProvider(async () => ({
    payments: [
      {
        environment: "test",
        model: "one_time",
        storeId: "STORE_TEST",
        externalOrderId: order.externalOrderId!,
        merchantOrderReference: order.id,
        externalPaymentId: `PAY_${crypto.randomUUID()}`,
        status: "succeeded",
        amount: { currency: "USD", minor: 2900n },
        occurredAt: new Date("2030-05-01T23:59:00.000Z"),
      },
    ],
    warnings: [warning],
  }));

  expect(
    await reconcileStalePayments(database.db, provider, {
      owner: "payment-warning-success-worker",
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    }),
  ).toEqual({ scanned: 1, applied: 1, retried: 0, operatorReview: 0 });

  expect(await database.db.select().from(commerceReconciliationRuns)).toMatchObject([
    {
      targetType: "payment_reconciliation_job",
      result: "applied_with_provider_warnings",
      afterJson: {
        state: "completed",
        warnings: [
          {
            message: warning.message,
            layer: warning.layer,
            aiHint: warning.aiHint,
          },
        ],
      },
    },
  ]);
  expect(JSON.stringify(await database.db.select().from(commerceReconciliationRuns))).not.toContain(
    "secretInternalDetail",
  );
});

it("does not let a reclaimed worker apply provider results returned to the stale worker", async () => {
  const claimNow = new Date("2030-05-02T00:00:00.000Z");
  const reclaimNow = new Date("2030-05-02T00:05:00.000Z");
  const reviewNow = new Date("2030-05-02T00:05:01.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const externalPaymentId = `PAY_${crypto.randomUUID()}`;
  let markLookupStarted!: () => void;
  let releaseLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    markLookupStarted = resolve;
  });
  const lookupRelease = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const provider = paymentProvider(async () => {
    markLookupStarted();
    await lookupRelease;
    return {
      payments: [
        {
          environment: "test",
          model: "one_time",
          storeId: "STORE_TEST",
          externalOrderId: order.externalOrderId!,
          merchantOrderReference: order.id,
          externalPaymentId,
          status: "succeeded",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        },
      ],
      warnings: [],
    };
  });
  const staleRun = reconcileStalePayments(database.db, provider, {
    owner: "stale-payment-worker",
    expectedStoreId: "STORE_TEST",
    now: claimNow,
    terminalClock: () => new Date("2030-05-02T00:06:00.000Z"),
    staleAfterMs: 24 * 60 * 60 * 1000,
  });
  await lookupStarted;

  const [reclaimed] = await claimPaymentReconciliationJobs(database.db, {
    owner: "replacement-payment-worker",
    now: reclaimNow,
  });
  expect(reclaimed?.orderId).toBe(order.id);
  if (!reclaimed?.leaseToken) throw new Error("replacement claim missing");
  expect(
    await operatorReviewPaymentReconciliationJob(database.db, {
      id: reclaimed.id,
      owner: "replacement-payment-worker",
      leaseToken: reclaimed.leaseToken,
      terminalNow: reviewNow,
      reason: "replacement worker owns terminal decision",
    }),
  ).toBe(true);
  releaseLookup();

  expect(await staleRun).toEqual({ scanned: 1, applied: 0, retried: 0, operatorReview: 0 });
  expect(await database.db.select().from(payments)).toHaveLength(0);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
  expect(await database.db.select().from(commerceAppliedEvents)).toHaveLength(0);
  expect(await database.db.select().from(commerceReconciliationRuns)).toMatchObject([
    {
      targetId: reclaimed.id,
      result: "operator_review_required",
      afterJson: {
        state: "operator_review",
        reason: "replacement worker owns terminal decision",
        warnings: [],
      },
    },
  ]);
});

it("commits a reconciliation event collision audit and quarantines the owned job", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const externalPaymentId = `PAY_${crypto.randomUUID()}`;
  const eventId = `payment-reconciliation:test:${externalPaymentId}:succeeded`;
  await database.db.insert(commerceAppliedEvents).values({
    environment: "test",
    providerEventId: eventId,
    eventType: "one_time_payment_failed",
    payloadHash: "d".repeat(64),
  });
  const provider = paymentProvider(async () => ({
    payments: [
      {
        environment: "test",
        model: "one_time",
        storeId: "STORE_TEST",
        externalOrderId: order.externalOrderId!,
        merchantOrderReference: order.id,
        externalPaymentId,
        status: "succeeded",
        amount: { currency: "USD", minor: 2900n },
        occurredAt: new Date("2030-05-01T23:59:00.000Z"),
      },
    ],
    warnings: [],
  }));

  expect(
    await reconcileStalePayments(database.db, provider, {
      owner: "collision-payment-worker",
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    }),
  ).toEqual({ scanned: 1, applied: 0, retried: 0, operatorReview: 1 });

  expect(await database.db.select().from(payments)).toHaveLength(0);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
  expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
    {
      orderId: order.id,
      state: "operator_review",
      operatorReviewReason: "provider event identity conflict",
    },
  ]);
  expect(
    await database.db
      .select()
      .from(commerceReconciliationRuns)
      .where(eq(commerceReconciliationRuns.targetId, eventId)),
  ).toMatchObject([
    {
      targetType: "provider_event_identity",
      result: "operator_review_required",
      beforeJson: {
        eventType: "one_time_payment_failed",
        payloadHash: "d".repeat(64),
      },
      afterJson: {
        eventType: "one_time_payment_succeeded",
        payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    },
  ]);
});

it.each(["empty", "pending"] as const)(
  "schedules bounded retry for a %s provider result",
  async (resultKind) => {
    const now = new Date("2030-05-02T00:00:00.000Z");
    const terminalNow = new Date("2030-05-02T00:00:01.000Z");
    const order = await seedOrder();
    await database.db
      .update(orders)
      .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
      .where(eq(orders.id, order.id));
    const provider = paymentProvider(async () => ({
      payments:
        resultKind === "empty"
          ? []
          : [
              {
                environment: "test",
                model: "one_time",
                storeId: "STORE_TEST",
                externalOrderId: order.externalOrderId!,
                merchantOrderReference: order.id,
                externalPaymentId: `PAY_${crypto.randomUUID()}`,
                status: "pending",
                amount: { currency: "USD", minor: 2900n },
                occurredAt: new Date("2030-05-01T23:59:00.000Z"),
              },
            ],
      warnings: [{ message: "provider state is not terminal", layer: "payments" }],
    }));

    expect(
      await reconcileStalePayments(database.db, provider, {
        owner: `payment-${resultKind}-worker`,
        expectedStoreId: "STORE_TEST",
        now,
        terminalClock: () => terminalNow,
        staleAfterMs: 24 * 60 * 60 * 1000,
      }),
    ).toEqual({ scanned: 1, applied: 0, retried: 1, operatorReview: 0 });

    expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
      {
        orderId: order.id,
        state: "pending",
        attempts: 1,
        leaseOwner: null,
        leaseToken: null,
        nextAttemptAt: new Date("2030-05-02T00:00:03.000Z"),
        lastErrorCode: resultKind === "empty" ? "PAYMENT_NOT_FOUND" : "PAYMENT_PENDING",
      },
    ]);
    expect(await database.db.select().from(payments)).toHaveLength(0);
    expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
  },
);

it("retries a provider failure and continues with the next job in the same batch", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const terminalNow = new Date("2030-05-02T00:00:01.000Z");
  const poisonOrder = await seedOrder();
  const healthyOrder = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-29T00:00:00.000Z") })
    .where(eq(orders.id, poisonOrder.id));
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, healthyOrder.id));
  const healthyPaymentId = `PAY_${crypto.randomUUID()}`;
  const lookup = vi.fn<PaymentProvider["getPayment"]>(async (lookupInput) => {
    if (lookupInput.merchantOrderReference === poisonOrder.id) {
      throw new Error("provider timeout with secret detail");
    }
    return {
      payments: [
        {
          environment: "test",
          model: "one_time",
          storeId: "STORE_TEST",
          externalOrderId: healthyOrder.externalOrderId!,
          merchantOrderReference: healthyOrder.id,
          externalPaymentId: healthyPaymentId,
          status: "succeeded",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        },
      ],
      warnings: [],
    };
  });

  expect(
    await reconcileStalePayments(database.db, paymentProvider(lookup), {
      owner: "payment-poison-isolation-worker",
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => terminalNow,
      staleAfterMs: 24 * 60 * 60 * 1000,
      limit: 10,
    }),
  ).toEqual({ scanned: 2, applied: 1, retried: 1, operatorReview: 0 });

  const jobs = await database.db.select().from(paymentReconciliationJobs);
  expect(jobs.find((job) => job.orderId === poisonOrder.id)).toMatchObject({
    state: "pending",
    attempts: 1,
    lastErrorCode: "PROVIDER_LOOKUP_FAILED",
  });
  expect(jobs.find((job) => job.orderId === healthyOrder.id)).toMatchObject({
    state: "completed",
    attempts: 0,
  });
  expect(await database.db.select().from(payments)).toMatchObject([
    { orderId: healthyOrder.id, externalPaymentId: healthyPaymentId },
  ]);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("quarantines a stale canceled result after an authoritative success and continues the batch", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const terminalNow = new Date("2030-05-02T00:00:01.000Z");
  const staleOrder = await seedOrder();
  const healthyOrder = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-29T00:00:00.000Z") })
    .where(eq(orders.id, staleOrder.id));
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, healthyOrder.id));

  let markStaleLookupStarted!: () => void;
  let releaseStaleLookup!: () => void;
  const staleLookupStarted = new Promise<void>((resolve) => {
    markStaleLookupStarted = resolve;
  });
  const staleLookupRelease = new Promise<void>((resolve) => {
    releaseStaleLookup = resolve;
  });
  const stalePaymentId = `PAY_STALE_${crypto.randomUUID()}`;
  const healthyPaymentId = `PAY_HEALTHY_${crypto.randomUUID()}`;
  const provider = paymentProvider(async (lookupInput) => {
    const order = lookupInput.merchantOrderReference === staleOrder.id ? staleOrder : healthyOrder;
    if (order.id === staleOrder.id) {
      markStaleLookupStarted();
      await staleLookupRelease;
    }
    return {
      payments: [
        {
          environment: "test",
          model: "one_time",
          storeId: "STORE_TEST",
          externalOrderId: order.externalOrderId!,
          merchantOrderReference: order.id,
          externalPaymentId: order.id === staleOrder.id ? stalePaymentId : healthyPaymentId,
          status: order.id === staleOrder.id ? ("canceled" as const) : ("succeeded" as const),
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        },
      ],
      warnings: [],
    };
  });

  const run = reconcileStalePayments(database.db, provider, {
    owner: "payment-mutation-poison-worker",
    expectedStoreId: "STORE_TEST",
    now,
    terminalClock: () => terminalNow,
    staleAfterMs: 24 * 60 * 60 * 1000,
    limit: 10,
  });
  await staleLookupStarted;
  const authoritativePaymentId = `PAY_AUTHORITATIVE_${crypto.randomUUID()}`;
  await processProviderEvent(
    database.db,
    {
      type: "one_time_payment_succeeded",
      eventId: `EVT_${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: staleOrder.externalOrderId!,
      merchantOrderReference: staleOrder.id,
      externalPaymentId: authoritativePaymentId,
      amount: { currency: "USD", minor: 2900n },
      occurredAt: new Date("2030-05-01T23:59:30.000Z"),
      storeId: "STORE_TEST",
    },
    "a".repeat(64),
  );
  releaseStaleLookup();

  expect(await run).toEqual({ scanned: 2, applied: 1, retried: 0, operatorReview: 1 });
  const jobs = await database.db.select().from(paymentReconciliationJobs);
  expect(jobs.find((job) => job.orderId === staleOrder.id)).toMatchObject({
    state: "operator_review",
    operatorReviewReason: "provider event application failed",
  });
  expect(jobs.find((job) => job.orderId === healthyOrder.id)).toMatchObject({
    state: "completed",
  });
  const storedPayments = await database.db.select().from(payments);
  expect(storedPayments.find((payment) => payment.orderId === staleOrder.id)).toMatchObject({
    externalPaymentId: authoritativePaymentId,
    status: "succeeded",
  });
  expect(storedPayments.find((payment) => payment.orderId === healthyOrder.id)).toMatchObject({
    externalPaymentId: healthyPaymentId,
    status: "succeeded",
  });
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(2);
  expect(
    await database.db.query.orders.findFirst({ where: eq(orders.id, staleOrder.id) }),
  ).toMatchObject({ status: "paid", canceledAt: null });
});

it("quarantines a succeeded payment identity conflict and continues the batch", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const terminalNow = new Date("2030-05-02T00:00:01.000Z");
  const conflictingOrder = await seedOrder();
  const poisonOrder = await seedOrder();
  const healthyOrder = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-29T00:00:00.000Z") })
    .where(eq(orders.id, poisonOrder.id));
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, healthyOrder.id));
  const conflictingPaymentId = `PAY_CONFLICT_${crypto.randomUUID()}`;
  await processProviderEvent(
    database.db,
    {
      type: "one_time_payment_succeeded",
      eventId: `EVT_${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: conflictingOrder.externalOrderId!,
      merchantOrderReference: conflictingOrder.id,
      externalPaymentId: conflictingPaymentId,
      amount: { currency: "USD", minor: 2900n },
      occurredAt: new Date("2030-05-01T23:58:00.000Z"),
      storeId: "STORE_TEST",
    },
    "a".repeat(64),
  );
  const healthyPaymentId = `PAY_HEALTHY_${crypto.randomUUID()}`;
  const provider = paymentProvider(async (lookupInput) => {
    const order =
      lookupInput.merchantOrderReference === poisonOrder.id ? poisonOrder : healthyOrder;
    return {
      payments: [
        {
          environment: "test",
          model: "one_time",
          storeId: "STORE_TEST",
          externalOrderId: order.externalOrderId!,
          merchantOrderReference: order.id,
          externalPaymentId: order.id === poisonOrder.id ? conflictingPaymentId : healthyPaymentId,
          status: "succeeded",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        },
      ],
      warnings: [],
    };
  });

  expect(
    await reconcileStalePayments(database.db, provider, {
      owner: "payment-identity-poison-worker",
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => terminalNow,
      staleAfterMs: 24 * 60 * 60 * 1000,
      limit: 10,
    }),
  ).toEqual({ scanned: 2, applied: 1, retried: 0, operatorReview: 1 });

  const jobs = await database.db.select().from(paymentReconciliationJobs);
  expect(jobs.find((job) => job.orderId === poisonOrder.id)).toMatchObject({
    state: "operator_review",
    operatorReviewReason: "provider event application failed",
  });
  expect(jobs.find((job) => job.orderId === healthyOrder.id)).toMatchObject({
    state: "completed",
  });
  const storedPayments = await database.db.select().from(payments);
  expect(storedPayments.find((payment) => payment.orderId === conflictingOrder.id)).toMatchObject({
    externalPaymentId: conflictingPaymentId,
    status: "succeeded",
  });
  expect(storedPayments.find((payment) => payment.orderId === healthyOrder.id)).toMatchObject({
    externalPaymentId: healthyPaymentId,
    status: "succeeded",
  });
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(2);
});

it.each([
  {
    name: "failed",
    terminals: (order: Awaited<ReturnType<typeof seedOrder>>) => [
      {
        externalPaymentId: `PAY_OLD_${crypto.randomUUID()}`,
        status: "failed" as const,
        occurredAt: new Date("2030-05-01T23:58:00.000Z"),
        order,
      },
      {
        externalPaymentId: `PAY_NEW_${crypto.randomUUID()}`,
        status: "failed" as const,
        occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        order,
      },
    ],
    expectedOrderStatus: "pending",
    expectedEventType: "one_time_payment_failed",
  },
  {
    name: "canceled",
    terminals: (order: Awaited<ReturnType<typeof seedOrder>>) => [
      {
        externalPaymentId: `PAY_A_${crypto.randomUUID()}`,
        status: "failed" as const,
        occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        order,
      },
      {
        externalPaymentId: `PAY_Z_${crypto.randomUUID()}`,
        status: "canceled" as const,
        occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        order,
      },
    ],
    expectedOrderStatus: "canceled",
    expectedEventType: "one_time_payment_canceled",
  },
] as const)("completes the latest stable $name terminal result", async (testCase) => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const terminals = testCase.terminals(order);
  const provider = paymentProvider(async () => ({
    payments: terminals.map((terminal) => ({
      environment: "test" as const,
      model: "one_time" as const,
      storeId: "STORE_TEST",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      externalPaymentId: terminal.externalPaymentId,
      status: terminal.status,
      amount: { currency: "USD" as const, minor: 2900n },
      occurredAt: terminal.occurredAt,
    })),
    warnings: [],
  }));
  const selected = terminals[terminals.length - 1]!;

  expect(
    await reconcileStalePayments(database.db, provider, {
      owner: `payment-terminal-${testCase.name}-worker`,
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    }),
  ).toEqual({ scanned: 1, applied: 1, retried: 0, operatorReview: 0 });

  expect(
    await database.db.query.orders.findFirst({ where: eq(orders.id, order.id) }),
  ).toMatchObject({ status: testCase.expectedOrderStatus });
  expect(await database.db.select().from(payments)).toHaveLength(0);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
  expect(await database.db.select().from(commerceAppliedEvents)).toMatchObject([
    {
      providerEventId: `payment-reconciliation:test:${selected.externalPaymentId}:${selected.status}`,
      eventType: testCase.expectedEventType,
    },
  ]);
  expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
    { orderId: order.id, state: "completed" },
  ]);
});

it.each([
  ["merchant identity", "provider payment facts mismatch"],
  ["order identity", "provider payment facts mismatch"],
  ["model", "payment-level period unavailable"],
  ["store", "provider payment facts mismatch"],
  ["environment", "provider payment facts mismatch"],
  ["amount", "provider payment facts mismatch"],
] as const)("quarantines a provider %s mismatch without mutation", async (mismatch, reason) => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const snapshot = {
    environment: mismatch === "environment" ? ("production" as const) : ("test" as const),
    model: mismatch === "model" ? ("subscription" as const) : ("one_time" as const),
    storeId: mismatch === "store" ? "STORE_OTHER" : "STORE_TEST",
    externalOrderId:
      mismatch === "order identity" ? `ORD_${crypto.randomUUID()}` : order.externalOrderId!,
    merchantOrderReference: mismatch === "merchant identity" ? crypto.randomUUID() : order.id,
    externalPaymentId: `PAY_${crypto.randomUUID()}`,
    status: "succeeded" as const,
    amount: {
      currency: "USD" as const,
      minor: mismatch === "amount" ? 2901n : 2900n,
    },
    occurredAt: new Date("2030-05-01T23:59:00.000Z"),
  };
  const provider = paymentProvider(async () => ({ payments: [snapshot], warnings: [] }));

  expect(
    await reconcileStalePayments(database.db, provider, {
      owner: `payment-mismatch-${mismatch}-worker`,
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    }),
  ).toEqual({ scanned: 1, applied: 0, retried: 0, operatorReview: 1 });

  expect(await database.db.select().from(payments)).toHaveLength(0);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
  expect(await database.db.select().from(commerceAppliedEvents)).toHaveLength(0);
  expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
    { orderId: order.id, state: "operator_review", operatorReviewReason: reason },
  ]);
});

it("does not seed or claim when payment reconciliation starts pre-aborted", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const controller = new AbortController();
  controller.abort(new DOMException("budget exhausted", "AbortError"));

  await expect(
    reconcileStalePayments(
      database.db,
      paymentProvider(async () => {
        throw new Error("pre-aborted reconciliation must not call the provider");
      }),
      {
        owner: "payment-pre-aborted-worker",
        expectedStoreId: "STORE_TEST",
        now,
        terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
        staleAfterMs: 24 * 60 * 60 * 1000,
        signal: controller.signal,
      },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });

  expect(await database.db.select().from(paymentReconciliationJobs)).toHaveLength(0);
  expect(await database.db.select().from(commerceReconciliationRuns)).toHaveLength(0);
  expect(await database.db.select().from(payments)).toHaveLength(0);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
});

it("rolls back a successful provider result when abort occurs while waiting for the live job lock", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const controller = new AbortController();
  let markLookupStarted!: () => void;
  let releaseLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    markLookupStarted = resolve;
  });
  const lookupRelease = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const externalPaymentId = `PAY_${crypto.randomUUID()}`;
  const provider = paymentProvider(async () => {
    markLookupStarted();
    await lookupRelease;
    return {
      payments: [
        {
          environment: "test",
          model: "one_time",
          storeId: "STORE_TEST",
          externalOrderId: order.externalOrderId!,
          merchantOrderReference: order.id,
          externalPaymentId,
          status: "succeeded",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        },
      ],
      warnings: [],
    };
  });
  const run = reconcileStalePayments(database.db, provider, {
    owner: "payment-abort-lock-worker",
    expectedStoreId: "STORE_TEST",
    now,
    terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
    staleAfterMs: 24 * 60 * 60 * 1000,
    signal: controller.signal,
  });
  await lookupStarted;
  const job = await database.db.query.paymentReconciliationJobs.findFirst({
    where: eq(paymentReconciliationJobs.orderId, order.id),
  });
  if (!job) throw new Error("claimed reconciliation job missing");

  let markJobLocked!: () => void;
  let releaseJobLock!: () => void;
  const jobLocked = new Promise<void>((resolve) => {
    markJobLocked = resolve;
  });
  const jobLockRelease = new Promise<void>((resolve) => {
    releaseJobLock = resolve;
  });
  const blocker = database.db.transaction(async (tx) => {
    await tx
      .select({ id: paymentReconciliationJobs.id })
      .from(paymentReconciliationJobs)
      .where(eq(paymentReconciliationJobs.id, job.id))
      .for("update");
    markJobLocked();
    await jobLockRelease;
  });
  await jobLocked;
  releaseLookup();

  let workerWaiting = false;
  for (let attempt = 0; attempt < 50 && !workerWaiting; attempt += 1) {
    const rows = await database.db.execute(sql<{ waiting: boolean }>`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query like '%payment_reconciliation_jobs%'
          and query not like '%pg_stat_activity%'
      ) as waiting
    `);
    workerWaiting = Boolean(rows[0]?.waiting);
    if (!workerWaiting) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(workerWaiting).toBe(true);
  controller.abort(new DOMException("budget exhausted", "AbortError"));
  releaseJobLock();
  await blocker;

  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  expect(await database.db.select().from(payments)).toHaveLength(0);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
  expect(await database.db.select().from(commerceAppliedEvents)).toHaveLength(0);
  expect(await database.db.select().from(commerceReconciliationRuns)).toHaveLength(0);
  expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
    {
      orderId: order.id,
      state: "processing",
      leaseOwner: "payment-abort-lock-worker",
      completedAt: null,
    },
  ]);
});

it.each(["retry", "operator_review"] as const)(
  "does not write a %s terminal decision when abort occurs while waiting for its job lock",
  async (outcome) => {
    const now = new Date("2030-05-02T00:00:00.000Z");
    const order = await seedOrder();
    await database.db
      .update(orders)
      .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
      .where(eq(orders.id, order.id));
    const controller = new AbortController();
    let markLookupStarted!: () => void;
    let releaseLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const lookupRelease = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const provider = paymentProvider(async () => {
      markLookupStarted();
      await lookupRelease;
      if (outcome === "retry") return { payments: [], warnings: [] };
      return {
        payments: [
          {
            environment: "test",
            model: "one_time",
            storeId: "STORE_OTHER",
            externalOrderId: order.externalOrderId!,
            merchantOrderReference: order.id,
            externalPaymentId: `PAY_${crypto.randomUUID()}`,
            status: "succeeded",
            amount: { currency: "USD", minor: 2900n },
            occurredAt: new Date("2030-05-01T23:59:00.000Z"),
          },
        ],
        warnings: [],
      };
    });
    const run = reconcileStalePayments(database.db, provider, {
      owner: `payment-abort-${outcome}-lock-worker`,
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
      signal: controller.signal,
    });
    await lookupStarted;
    const job = await database.db.query.paymentReconciliationJobs.findFirst({
      where: eq(paymentReconciliationJobs.orderId, order.id),
    });
    if (!job) throw new Error("claimed reconciliation job missing");

    let markJobLocked!: () => void;
    let releaseJobLock!: () => void;
    const jobLocked = new Promise<void>((resolve) => {
      markJobLocked = resolve;
    });
    const jobLockRelease = new Promise<void>((resolve) => {
      releaseJobLock = resolve;
    });
    const blocker = database.db.transaction(async (tx) => {
      await tx
        .select({ id: paymentReconciliationJobs.id })
        .from(paymentReconciliationJobs)
        .where(eq(paymentReconciliationJobs.id, job.id))
        .for("update");
      markJobLocked();
      await jobLockRelease;
    });
    await jobLocked;
    releaseLookup();

    let workerWaiting = false;
    for (let attempt = 0; attempt < 50 && !workerWaiting; attempt += 1) {
      const rows = await database.db.execute(sql<{ waiting: boolean }>`
        select exists (
          select 1
          from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%payment_reconciliation_jobs%'
            and query not like '%pg_stat_activity%'
        ) as waiting
      `);
      workerWaiting = Boolean(rows[0]?.waiting);
      if (!workerWaiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(workerWaiting).toBe(true);
    controller.abort(new DOMException("budget exhausted", "AbortError"));
    releaseJobLock();
    await blocker;

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(await database.db.select().from(payments)).toHaveLength(0);
    expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
    expect(await database.db.select().from(commerceAppliedEvents)).toHaveLength(0);
    expect(await database.db.select().from(commerceReconciliationRuns)).toHaveLength(0);
    expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
      {
        orderId: order.id,
        state: "processing",
        attempts: 0,
        leaseOwner: `payment-abort-${outcome}-lock-worker`,
        completedAt: null,
      },
    ]);
  },
);

it.each(["return", "throw"] as const)(
  "performs no post-abort mutation when the provider %s after abort",
  async (providerOutcome) => {
    const now = new Date("2030-05-02T00:00:00.000Z");
    const order = await seedOrder();
    await database.db
      .update(orders)
      .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
      .where(eq(orders.id, order.id));
    const controller = new AbortController();
    const provider = paymentProvider(async () => {
      controller.abort(new DOMException("budget exhausted", "AbortError"));
      if (providerOutcome === "throw") {
        throw new DOMException("request aborted", "AbortError");
      }
      return {
        payments: [
          {
            environment: "test",
            model: "one_time",
            storeId: "STORE_TEST",
            externalOrderId: order.externalOrderId!,
            merchantOrderReference: order.id,
            externalPaymentId: `PAY_${crypto.randomUUID()}`,
            status: "succeeded",
            amount: { currency: "USD", minor: 2900n },
            occurredAt: new Date("2030-05-01T23:59:00.000Z"),
          },
        ],
        warnings: [],
      };
    });

    await expect(
      reconcileStalePayments(database.db, provider, {
        owner: `payment-abort-${providerOutcome}-worker`,
        expectedStoreId: "STORE_TEST",
        now,
        terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
        staleAfterMs: 24 * 60 * 60 * 1000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(await database.db.select().from(payments)).toHaveLength(0);
    expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
    expect(await database.db.select().from(commerceAppliedEvents)).toHaveLength(0);
    expect(await database.db.select().from(commerceReconciliationRuns)).toHaveLength(0);
    expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
      {
        orderId: order.id,
        state: "processing",
        attempts: 0,
        leaseOwner: `payment-abort-${providerOutcome}-worker`,
      },
    ]);
  },
);

it("reports exact mixed counters and never exceeds the reconciliation limit", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const appliedOrder = await seedOrder();
  const retryOrder = await seedOrder();
  const reviewOrder = await seedOrder();
  const unclaimedOrder = await seedOrder();
  for (const [index, order] of [appliedOrder, retryOrder, reviewOrder, unclaimedOrder].entries()) {
    await database.db
      .update(orders)
      .set({ createdAt: new Date(`2030-04-${26 + index}T00:00:00.000Z`) })
      .where(eq(orders.id, order.id));
  }
  const lookup = vi.fn<PaymentProvider["getPayment"]>(async (lookupInput) => {
    if (lookupInput.merchantOrderReference === retryOrder.id) {
      return { payments: [], warnings: [] };
    }
    const order =
      lookupInput.merchantOrderReference === appliedOrder.id ? appliedOrder : reviewOrder;
    return {
      payments: [
        {
          environment: "test",
          model: "one_time",
          storeId: order.id === reviewOrder.id ? "STORE_OTHER" : "STORE_TEST",
          externalOrderId: order.externalOrderId!,
          merchantOrderReference: order.id,
          externalPaymentId: `PAY_${crypto.randomUUID()}`,
          status: "succeeded",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        },
      ],
      warnings: [],
    };
  });

  expect(
    await reconcileStalePayments(database.db, paymentProvider(lookup), {
      owner: "payment-mixed-counter-worker",
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
      limit: 3,
    }),
  ).toEqual({ scanned: 3, applied: 1, retried: 1, operatorReview: 1 });

  expect(lookup).toHaveBeenCalledTimes(3);
  const jobs = await database.db.select().from(paymentReconciliationJobs);
  expect(jobs).toHaveLength(3);
  expect(jobs.find((job) => job.orderId === appliedOrder.id)?.state).toBe("completed");
  expect(jobs.find((job) => job.orderId === retryOrder.id)?.state).toBe("pending");
  expect(jobs.find((job) => job.orderId === reviewOrder.id)?.state).toBe("operator_review");
  expect(jobs.find((job) => job.orderId === unclaimedOrder.id)).toBeUndefined();
});

it("quarantines duplicate succeeded provider payments without mutating the order", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const snapshot = {
    environment: "test" as const,
    model: "one_time" as const,
    storeId: "STORE_TEST",
    externalOrderId: order.externalOrderId!,
    merchantOrderReference: order.id,
    status: "succeeded" as const,
    amount: { currency: "USD" as const, minor: 2900n },
    occurredAt: new Date("2030-05-01T23:59:00.000Z"),
  };
  const provider = paymentProvider(
    vi.fn<PaymentProvider["getPayment"]>().mockResolvedValue({
      payments: [
        { ...snapshot, externalPaymentId: `PAY_${crypto.randomUUID()}` },
        { ...snapshot, externalPaymentId: `PAY_${crypto.randomUUID()}` },
      ],
      warnings: [],
    }),
  );

  expect(
    await reconcileStalePayments(database.db, provider, {
      owner: "payment-duplicate-worker",
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    }),
  ).toEqual({ scanned: 1, applied: 0, retried: 0, operatorReview: 1 });

  expect(await database.db.select().from(payments)).toHaveLength(0);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
  expect(await database.db.select().from(commerceAppliedEvents)).toHaveLength(0);
  expect(
    await database.db.query.orders.findFirst({ where: eq(orders.id, order.id) }),
  ).toMatchObject({ status: "pending", paidAt: null });
  expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
    {
      orderId: order.id,
      state: "operator_review",
      operatorReviewReason: "multiple succeeded provider payments returned",
    },
  ]);
  expect(await database.db.select().from(commerceReconciliationRuns)).toMatchObject([
    { result: "operator_review_required" },
  ]);
});

it("recovers the unique succeeded attempt among pending failed and canceled attempts", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const base = {
    environment: "test" as const,
    model: "one_time" as const,
    storeId: "STORE_TEST",
    externalOrderId: order.externalOrderId!,
    merchantOrderReference: order.id,
    amount: { currency: "USD" as const, minor: 2900n },
    occurredAt: new Date("2030-05-01T23:59:00.000Z"),
  };
  const succeededPaymentId = `PAY_${crypto.randomUUID()}`;
  const provider = paymentProvider(
    vi.fn<PaymentProvider["getPayment"]>().mockResolvedValue({
      payments: [
        { ...base, externalPaymentId: `PAY_${crypto.randomUUID()}`, status: "pending" },
        { ...base, externalPaymentId: `PAY_${crypto.randomUUID()}`, status: "failed" },
        { ...base, externalPaymentId: succeededPaymentId, status: "succeeded" },
        { ...base, externalPaymentId: `PAY_${crypto.randomUUID()}`, status: "canceled" },
      ],
      warnings: [],
    }),
  );

  expect(
    await reconcileStalePayments(database.db, provider, {
      owner: "payment-mixed-attempt-worker",
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    }),
  ).toEqual({ scanned: 1, applied: 1, retried: 0, operatorReview: 0 });
  expect(await database.db.select().from(payments)).toMatchObject([
    { externalPaymentId: succeededPaymentId, status: "succeeded" },
  ]);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(1);
  expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
    { orderId: order.id, state: "completed" },
  ]);
});

it("does not fulfill a distinct succeeded payment for an already paid one-time order", async () => {
  const order = await seedOrder();
  const firstPaymentId = `PAY_${crypto.randomUUID()}`;
  const secondPaymentId = `PAY_${crypto.randomUUID()}`;
  const event = (eventId: string, externalPaymentId: string) => ({
    type: "one_time_payment_succeeded" as const,
    eventId,
    environment: "test" as const,
    externalOrderId: order.externalOrderId!,
    merchantOrderReference: order.id,
    externalPaymentId,
    amount: { currency: "USD" as const, minor: 2900n },
    occurredAt: new Date("2030-05-01T23:59:00.000Z"),
    storeId: "STORE_TEST",
  });

  await processProviderEvent(
    database.db,
    event(`EVT_${crypto.randomUUID()}`, firstPaymentId),
    "a".repeat(64),
  );
  const secondEvent = event(`EVT_${crypto.randomUUID()}`, secondPaymentId);
  await processProviderEvent(database.db, secondEvent, "b".repeat(64));
  await processProviderEvent(database.db, secondEvent, "b".repeat(64));

  expect(await database.db.select().from(payments)).toMatchObject([
    { orderId: order.id, externalPaymentId: firstPaymentId, status: "succeeded" },
  ]);
  expect(await database.db.select().from(fulfillmentJobs)).toMatchObject([
    { sourceId: firstPaymentId },
  ]);
  expect(
    await database.db
      .select()
      .from(commerceReconciliationRuns)
      .where(eq(commerceReconciliationRuns.targetId, order.id)),
  ).toMatchObject([
    {
      targetType: "one_time_payment",
      result: "operator_review_required",
      afterJson: {
        reason: "distinct_succeeded_payment_for_paid_order",
        existingExternalPaymentId: firstPaymentId,
        conflictingExternalPaymentId: secondPaymentId,
      },
    },
  ]);
});

it("quarantines a reconciliation job when a distinct payment already fulfilled the order", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder();
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  await database.db.insert(paymentReconciliationJobs).values({
    orderId: order.id,
    nextAttemptAt: now,
  });
  const firstPaymentId = `PAY_${crypto.randomUUID()}`;
  await processProviderEvent(
    database.db,
    {
      type: "one_time_payment_succeeded",
      eventId: `EVT_${crypto.randomUUID()}`,
      environment: "test",
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      externalPaymentId: firstPaymentId,
      amount: { currency: "USD", minor: 2900n },
      occurredAt: new Date("2030-05-01T23:58:00.000Z"),
      storeId: "STORE_TEST",
    },
    "a".repeat(64),
  );
  const secondPaymentId = `PAY_${crypto.randomUUID()}`;
  const provider = paymentProvider(async () => ({
    payments: [
      {
        environment: "test",
        model: "one_time",
        storeId: "STORE_TEST",
        externalOrderId: order.externalOrderId!,
        merchantOrderReference: order.id,
        externalPaymentId: secondPaymentId,
        status: "succeeded",
        amount: { currency: "USD", minor: 2900n },
        occurredAt: new Date("2030-05-01T23:59:00.000Z"),
      },
    ],
    warnings: [],
  }));

  expect(
    await reconcileStalePayments(database.db, provider, {
      owner: "payment-distinct-reconciliation-worker",
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    }),
  ).toEqual({ scanned: 1, applied: 0, retried: 0, operatorReview: 1 });

  expect(await database.db.select().from(payments)).toMatchObject([
    { orderId: order.id, externalPaymentId: firstPaymentId },
  ]);
  expect(await database.db.select().from(fulfillmentJobs)).toMatchObject([
    { sourceId: firstPaymentId },
  ]);
  expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
    {
      orderId: order.id,
      state: "operator_review",
      operatorReviewReason: "distinct succeeded payment already fulfilled order",
    },
  ]);
  expect(
    await database.db
      .select()
      .from(commerceReconciliationRuns)
      .where(eq(commerceReconciliationRuns.targetId, order.id)),
  ).toHaveLength(1);
});

it("fails closed and persistently audits an event id reused with different identity", async () => {
  const order = await seedOrder();
  const eventId = `EVT_${crypto.randomUUID()}`;
  const failedEvent = {
    type: "one_time_payment_failed" as const,
    eventId,
    environment: "test" as const,
    externalOrderId: order.externalOrderId!,
    merchantOrderReference: order.id,
    occurredAt: new Date("2030-05-01T23:58:00.000Z"),
  };
  const conflictingEvent = {
    ...failedEvent,
    type: "one_time_payment_canceled" as const,
    occurredAt: new Date("2030-05-01T23:59:00.000Z"),
  };

  await processProviderEvent(database.db, failedEvent, "a".repeat(64));
  await expect(processProviderEvent(database.db, conflictingEvent, "b".repeat(64))).rejects.toThrow(
    "provider event identity conflict",
  );
  await expect(processProviderEvent(database.db, conflictingEvent, "b".repeat(64))).rejects.toThrow(
    "provider event identity conflict",
  );

  expect(
    await database.db.query.orders.findFirst({ where: eq(orders.id, order.id) }),
  ).toMatchObject({ status: "pending", canceledAt: null });
  expect(
    await database.db
      .select()
      .from(commerceAppliedEvents)
      .where(
        and(
          eq(commerceAppliedEvents.environment, "test"),
          eq(commerceAppliedEvents.providerEventId, eventId),
        ),
      ),
  ).toMatchObject([{ eventType: "one_time_payment_failed", payloadHash: "a".repeat(64) }]);
  expect(
    await database.db
      .select()
      .from(commerceReconciliationRuns)
      .where(eq(commerceReconciliationRuns.targetId, eventId)),
  ).toMatchObject([
    {
      targetType: "provider_event_identity",
      result: "operator_review_required",
      beforeJson: {
        eventType: "one_time_payment_failed",
        payloadHash: "a".repeat(64),
      },
      afterJson: {
        eventType: "one_time_payment_canceled",
        payloadHash: "b".repeat(64),
      },
    },
  ]);
});

it.each(["succeeded", "failed", "canceled"] as const)(
  "rejects a one-time %s event targeting a subscription product before any mutation",
  async (status) => {
    const order = await seedOrder({ model: "subscription" });
    const eventId = `EVT_${crypto.randomUUID()}`;
    const common = {
      eventId,
      environment: "test" as const,
      externalOrderId: order.externalOrderId!,
      merchantOrderReference: order.id,
      externalPaymentId: `PAY_${crypto.randomUUID()}`,
      occurredAt: new Date("2030-05-01T23:59:00.000Z"),
      storeId: "STORE_TEST",
    };
    const event =
      status === "succeeded"
        ? {
            ...common,
            type: "one_time_payment_succeeded" as const,
            amount: { currency: "USD" as const, minor: 2900n },
          }
        : status === "failed"
          ? { ...common, type: "one_time_payment_failed" as const }
          : { ...common, type: "one_time_payment_canceled" as const };

    await expect(processProviderEvent(database.db, event, "c".repeat(64))).rejects.toThrow(
      "one-time payment event product model mismatch",
    );

    expect(
      await database.db.query.orders.findFirst({ where: eq(orders.id, order.id) }),
    ).toMatchObject({ status: "pending", paidAt: null });
    expect(await database.db.select().from(payments)).toHaveLength(0);
    expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(commerceAppliedEvents)
        .where(eq(commerceAppliedEvents.providerEventId, eventId)),
    ).toHaveLength(0);
  },
);

it("quarantines every subscription payment without manufacturing a historical period", async () => {
  const now = new Date("2030-05-02T00:00:00.000Z");
  const order = await seedOrder({ model: "subscription" });
  await database.db
    .update(orders)
    .set({ createdAt: new Date("2030-04-30T00:00:00.000Z") })
    .where(eq(orders.id, order.id));
  const provider = paymentProvider(
    vi.fn<PaymentProvider["getPayment"]>().mockResolvedValue({
      payments: [
        {
          environment: "test",
          model: "subscription",
          storeId: "STORE_TEST",
          externalOrderId: order.externalOrderId!,
          merchantOrderReference: order.id,
          externalPaymentId: `PAY_${crypto.randomUUID()}`,
          status: "succeeded",
          amount: { currency: "USD", minor: 2900n },
          occurredAt: new Date("2030-05-01T23:59:00.000Z"),
        },
      ],
      warnings: [],
    }),
  );

  expect(
    await reconcileStalePayments(database.db, provider, {
      owner: "payment-subscription-worker",
      expectedStoreId: "STORE_TEST",
      now,
      terminalClock: () => new Date("2030-05-02T00:00:01.000Z"),
      staleAfterMs: 24 * 60 * 60 * 1000,
    }),
  ).toEqual({ scanned: 1, applied: 0, retried: 0, operatorReview: 1 });

  expect(await database.db.select().from(payments)).toHaveLength(0);
  expect(await database.db.select().from(subscriptionPeriods)).toHaveLength(0);
  expect(await database.db.select().from(subscriptions)).toHaveLength(0);
  expect(await database.db.select().from(fulfillmentJobs)).toHaveLength(0);
  expect(await database.db.select().from(creditGrants)).toHaveLength(0);
  expect(await database.db.select().from(creditLedgerEntries)).toHaveLength(0);
  expect(await database.db.select().from(commerceAppliedEvents)).toHaveLength(0);
  expect(await database.db.select().from(paymentReconciliationJobs)).toMatchObject([
    {
      orderId: order.id,
      state: "operator_review",
      operatorReviewReason: "payment-level period unavailable",
    },
  ]);
});

it("installs a persistent idempotency key for operator audit", async () => {
  const columns = await database.db.execute(sql<{ column_name: string }>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'commerce_reconciliation_runs'
      and column_name = 'dedup_key'
  `);
  const indexes = await database.db.execute(sql<{ indexname: string }>`
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'commerce_reconciliation_runs'
      and indexname = 'commerce_reconciliation_run_dedup_uq'
  `);

  expect(columns).toHaveLength(1);
  expect(indexes).toHaveLength(1);
});

it("allows only one reconciliation job for a global order id", async () => {
  const order = await seedOrder();
  await database.db.insert(paymentReconciliationJobs).values({ orderId: order.id });

  await expect(
    (async () => {
      await database.db.insert(paymentReconciliationJobs).values({ orderId: order.id });
    })(),
  ).rejects.toThrow();
});

it.each([
  ["attempts above the maximum", { state: "pending", attempts: 13 }],
  ["pending at the maximum", { state: "pending", attempts: 12 }],
  [
    "processing at the maximum",
    {
      state: "processing",
      attempts: 12,
      leaseOwner: "invalid-owner",
      leaseToken: "invalid-token",
      leaseExpiresAt: new Date("2030-05-01T00:05:00.000Z"),
    },
  ],
  [
    "dead letter below the maximum",
    {
      state: "dead_letter",
      attempts: 11,
      completedAt: new Date("2030-05-01T00:00:00.000Z"),
    },
  ],
] as const)("rejects an invalid reconciliation attempt state: %s", async (_name, values) => {
  const order = await seedOrder();
  await expect(
    (async () => {
      await database.db.insert(paymentReconciliationJobs).values({
        orderId: order.id,
        ...values,
      });
    })(),
  ).rejects.toThrow();
});

it("enforces non-null audit dedup keys while allowing legacy null keys", async () => {
  const values = {
    targetType: "payment_reconciliation_job",
    targetId: crypto.randomUUID(),
    actorType: "worker",
    beforeJson: {},
    afterJson: {},
    result: "operator_review_required",
  } as const;

  await database.db.insert(commerceReconciliationRuns).values([
    { ...values, dedupKey: null },
    { ...values, dedupKey: null },
    { ...values, dedupKey: "payment-reconciliation:dedup-proof" },
  ]);
  await expect(
    (async () => {
      await database.db
        .insert(commerceReconciliationRuns)
        .values({ ...values, dedupKey: "payment-reconciliation:dedup-proof" });
    })(),
  ).rejects.toThrow();

  const rows = await database.db.select().from(commerceReconciliationRuns);
  expect(rows.filter((row) => row.dedupKey === null)).toHaveLength(2);
  expect(rows.filter((row) => row.dedupKey === "payment-reconciliation:dedup-proof")).toHaveLength(
    1,
  );
});

it("allows only one concurrent claim for a due reconciliation job", async () => {
  const now = new Date("2030-05-01T00:00:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, nextAttemptAt: now })
    .returning();
  if (!job) throw new Error("reconciliation job insert failed");

  const [first, second] = await Promise.all([
    claimPaymentReconciliationJobs(database.db, { owner: "payment-worker-a", now, limit: 1 }),
    claimPaymentReconciliationJobs(database.db, { owner: "payment-worker-b", now, limit: 1 }),
  ]);
  const claimed = [...first, ...second];

  expect(claimed).toHaveLength(1);
  expect(claimed[0]).toMatchObject({
    id: job.id,
    state: "processing",
    attempts: 0,
    leaseExpiresAt: new Date("2030-05-01T00:05:00.000Z"),
  });
  expect(claimed[0]?.leaseOwner).toMatch(/^payment-worker-[ab]$/);
  expect(claimed[0]?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
});

it("claims newly due jobs within one turn while an older poison job keeps retrying", async () => {
  const start = new Date("2030-05-01T00:00:00.000Z");
  const poisonOrder = await seedOrder();
  const [poison] = await database.db
    .insert(paymentReconciliationJobs)
    .values({
      orderId: poisonOrder.id,
      nextAttemptAt: start,
      createdAt: new Date("2029-05-01T00:00:00.000Z"),
    })
    .returning();
  if (!poison) throw new Error("poison reconciliation job insert failed");

  let [poisonClaim] = await claimPaymentReconciliationJobs(database.db, {
    owner: "poison-worker-0",
    now: start,
    limit: 1,
  });
  if (!poisonClaim?.leaseToken) throw new Error("poison claim missing");
  expect(
    await retryPaymentReconciliationJob(database.db, {
      id: poison.id,
      owner: "poison-worker-0",
      leaseToken: poisonClaim.leaseToken,
      terminalNow: start,
      errorCode: "POISON",
    }),
  ).toBe(true);

  for (let round = 1; round <= 3; round += 1) {
    const persistedPoison = await database.db.query.paymentReconciliationJobs.findFirst({
      where: eq(paymentReconciliationJobs.id, poison.id),
    });
    if (!persistedPoison) throw new Error("poison job disappeared");
    const claimAt = persistedPoison.nextAttemptAt;
    const normalOrder = await seedOrder();
    const [normal] = await database.db
      .insert(paymentReconciliationJobs)
      .values({
        orderId: normalOrder.id,
        nextAttemptAt: new Date(claimAt.getTime() - 1),
        createdAt: new Date(start.getTime() + round),
      })
      .returning();
    if (!normal) throw new Error("normal reconciliation job insert failed");

    const [normalClaim] = await claimPaymentReconciliationJobs(database.db, {
      owner: `normal-worker-${round}`,
      now: claimAt,
      limit: 1,
    });
    expect(normalClaim?.id).toBe(normal.id);
    if (!normalClaim?.leaseToken) throw new Error("normal claim missing");
    expect(
      await completePaymentReconciliationJob(database.db, {
        id: normal.id,
        owner: `normal-worker-${round}`,
        leaseToken: normalClaim.leaseToken,
        terminalNow: claimAt,
      }),
    ).toBe(true);

    [poisonClaim] = await claimPaymentReconciliationJobs(database.db, {
      owner: `poison-worker-${round}`,
      now: claimAt,
      limit: 1,
    });
    expect(poisonClaim?.id).toBe(poison.id);
    if (!poisonClaim?.leaseToken) throw new Error("poison reclaim missing");
    expect(
      await retryPaymentReconciliationJob(database.db, {
        id: poison.id,
        owner: `poison-worker-${round}`,
        leaseToken: poisonClaim.leaseToken,
        terminalNow: claimAt,
        errorCode: "POISON",
      }),
    ).toBe(true);
  }
});

it("claims newly due jobs while an older crashed lease keeps expiring", async () => {
  const start = new Date("2030-05-01T00:00:00.000Z");
  const crashedOrder = await seedOrder();
  const [crashed] = await database.db
    .insert(paymentReconciliationJobs)
    .values({
      orderId: crashedOrder.id,
      nextAttemptAt: start,
      createdAt: new Date("2029-05-01T00:00:00.000Z"),
    })
    .returning();
  if (!crashed) throw new Error("crashed reconciliation job insert failed");

  let [crashedClaim] = await claimPaymentReconciliationJobs(database.db, {
    owner: "crashed-worker-0",
    now: start,
    limit: 1,
  });
  if (!crashedClaim?.leaseExpiresAt) throw new Error("crashed claim lease missing");

  for (let round = 1; round <= 3; round += 1) {
    const claimAt = crashedClaim.leaseExpiresAt;
    const normalOrder = await seedOrder();
    const [normal] = await database.db
      .insert(paymentReconciliationJobs)
      .values({
        orderId: normalOrder.id,
        nextAttemptAt: new Date(claimAt.getTime() - 1),
        createdAt: new Date(start.getTime() + round),
      })
      .returning();
    if (!normal) throw new Error("normal reconciliation job insert failed");

    const [normalClaim] = await claimPaymentReconciliationJobs(database.db, {
      owner: `normal-after-crash-${round}`,
      now: claimAt,
      limit: 1,
    });
    expect(normalClaim?.id).toBe(normal.id);
    if (!normalClaim?.leaseToken) throw new Error("normal claim missing");
    expect(
      await completePaymentReconciliationJob(database.db, {
        id: normal.id,
        owner: `normal-after-crash-${round}`,
        leaseToken: normalClaim.leaseToken,
        terminalNow: claimAt,
      }),
    ).toBe(true);

    [crashedClaim] = await claimPaymentReconciliationJobs(database.db, {
      owner: `crashed-worker-${round}`,
      now: claimAt,
      limit: 1,
    });
    expect(crashedClaim?.id).toBe(crashed.id);
    if (!crashedClaim?.leaseExpiresAt) throw new Error("crashed reclaim lease missing");
  }
});

it("changes the lease token when the same owner reclaims an expired job", async () => {
  const firstNow = new Date("2030-05-01T00:00:00.000Z");
  const reclaimNow = new Date("2030-05-01T00:05:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, nextAttemptAt: firstNow })
    .returning();
  if (!job) throw new Error("reconciliation job insert failed");

  const [first] = await claimPaymentReconciliationJobs(database.db, {
    owner: "payment-shared-owner",
    now: firstNow,
    limit: 1,
  });
  const [reclaimed] = await claimPaymentReconciliationJobs(database.db, {
    owner: "payment-shared-owner",
    now: reclaimNow,
    limit: 1,
  });

  expect(first?.leaseToken).toBeTruthy();
  expect(reclaimed).toMatchObject({
    id: job.id,
    state: "processing",
    leaseOwner: "payment-shared-owner",
    leaseExpiresAt: new Date("2030-05-01T00:10:00.000Z"),
  });
  expect(reclaimed?.leaseToken).toBeTruthy();
  expect(reclaimed?.leaseToken).not.toBe(first?.leaseToken);

  const persisted = await database.db.query.paymentReconciliationJobs.findFirst({
    where: eq(paymentReconciliationJobs.id, job.id),
  });
  expect(persisted?.leaseToken).toBe(reclaimed?.leaseToken);
});

it("does not let a stale token complete a same-owner reclaimed job", async () => {
  const firstNow = new Date("2030-05-01T00:00:00.000Z");
  const reclaimNow = new Date("2030-05-01T00:05:00.000Z");
  const terminalNow = new Date("2030-05-01T00:06:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, nextAttemptAt: firstNow })
    .returning();
  if (!job) throw new Error("reconciliation job insert failed");
  const [first] = await claimPaymentReconciliationJobs(database.db, {
    owner: "payment-shared-owner",
    now: firstNow,
  });
  const [reclaimed] = await claimPaymentReconciliationJobs(database.db, {
    owner: "payment-shared-owner",
    now: reclaimNow,
  });
  if (!first?.leaseToken || !reclaimed?.leaseToken) throw new Error("claim token missing");

  const completed = await completePaymentReconciliationJob(database.db, {
    id: job.id,
    owner: "payment-shared-owner",
    leaseToken: first.leaseToken,
    terminalNow,
  });

  expect(completed).toBe(false);
  const persisted = await database.db.query.paymentReconciliationJobs.findFirst({
    where: eq(paymentReconciliationJobs.id, job.id),
  });
  expect(persisted).toMatchObject({
    state: "processing",
    leaseToken: reclaimed.leaseToken,
    completedAt: null,
  });
});

it.each(["retry", "operator_review"] as const)(
  "does not let a stale token write %s state or audit after same-owner reclaim",
  async (operation) => {
    const firstNow = new Date("2030-05-01T00:00:00.000Z");
    const reclaimNow = new Date("2030-05-01T00:05:00.000Z");
    const terminalNow = new Date("2030-05-01T00:06:00.000Z");
    const order = await seedOrder();
    const [job] = await database.db
      .insert(paymentReconciliationJobs)
      .values({ orderId: order.id, nextAttemptAt: firstNow })
      .returning();
    if (!job) throw new Error("reconciliation job insert failed");
    const [first] = await claimPaymentReconciliationJobs(database.db, {
      owner: "payment-shared-owner",
      now: firstNow,
    });
    const [reclaimed] = await claimPaymentReconciliationJobs(database.db, {
      owner: "payment-shared-owner",
      now: reclaimNow,
    });
    if (!first?.leaseToken || !reclaimed?.leaseToken) throw new Error("claim token missing");

    const transitioned =
      operation === "retry"
        ? await retryPaymentReconciliationJob(database.db, {
            id: job.id,
            owner: "payment-shared-owner",
            leaseToken: first.leaseToken,
            terminalNow,
            errorCode: "STALE",
          })
        : await operatorReviewPaymentReconciliationJob(database.db, {
            id: job.id,
            owner: "payment-shared-owner",
            leaseToken: first.leaseToken,
            terminalNow,
            reason: "stale must not review",
          });

    expect(transitioned).toBe(false);
    const persisted = await database.db.query.paymentReconciliationJobs.findFirst({
      where: eq(paymentReconciliationJobs.id, job.id),
    });
    expect(persisted).toMatchObject({
      state: "processing",
      leaseToken: reclaimed.leaseToken,
      attempts: 0,
    });
    expect(
      await database.db
        .select()
        .from(commerceReconciliationRuns)
        .where(eq(commerceReconciliationRuns.targetId, job.id)),
    ).toHaveLength(0);
  },
);

it("does not retry after the claimed lease naturally expires", async () => {
  const claimNow = new Date("2030-05-01T00:00:00.000Z");
  const terminalNow = new Date("2030-05-01T00:06:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, nextAttemptAt: claimNow })
    .returning();
  if (!job) throw new Error("reconciliation job insert failed");
  const [claimed] = await claimPaymentReconciliationJobs(database.db, {
    owner: "payment-expired-owner",
    now: claimNow,
  });
  if (!claimed?.leaseToken) throw new Error("claim token missing");

  const retried = await retryPaymentReconciliationJob(database.db, {
    id: job.id,
    owner: "payment-expired-owner",
    leaseToken: claimed.leaseToken,
    terminalNow,
    errorCode: "PROVIDER_TIMEOUT",
  });

  expect(retried).toBe(false);
  const persisted = await database.db.query.paymentReconciliationJobs.findFirst({
    where: eq(paymentReconciliationJobs.id, job.id),
  });
  expect(persisted).toMatchObject({
    state: "processing",
    attempts: 0,
    leaseToken: claimed.leaseToken,
  });
  expect(
    await database.db
      .select()
      .from(commerceReconciliationRuns)
      .where(eq(commerceReconciliationRuns.targetId, job.id)),
  ).toHaveLength(0);
});

it("does not write operator-review state or audit after the claimed lease expires", async () => {
  const claimNow = new Date("2030-05-01T00:00:00.000Z");
  const terminalNow = new Date("2030-05-01T00:06:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, nextAttemptAt: claimNow })
    .returning();
  if (!job) throw new Error("reconciliation job insert failed");
  const [claimed] = await claimPaymentReconciliationJobs(database.db, {
    owner: "payment-expired-review-owner",
    now: claimNow,
  });
  if (!claimed?.leaseToken) throw new Error("claim token missing");

  expect(
    await operatorReviewPaymentReconciliationJob(database.db, {
      id: job.id,
      owner: "payment-expired-review-owner",
      leaseToken: claimed.leaseToken,
      terminalNow,
      reason: "expired must not review",
    }),
  ).toBe(false);
  expect(
    await database.db
      .select()
      .from(commerceReconciliationRuns)
      .where(eq(commerceReconciliationRuns.targetId, job.id)),
  ).toHaveLength(0);
});

it.each(invalidWarningCases)(
  "rejects %s before retry can persist provider warnings",
  async (_name, warnings) => {
    const claimNow = new Date("2030-05-01T00:00:00.000Z");
    const order = await seedOrder();
    const [job] = await database.db
      .insert(paymentReconciliationJobs)
      .values({ orderId: order.id, nextAttemptAt: claimNow })
      .returning();
    if (!job) throw new Error("reconciliation job insert failed");
    const [claimed] = await claimPaymentReconciliationJobs(database.db, {
      owner: "payment-warning-retry-owner",
      now: claimNow,
    });
    if (!claimed?.leaseToken) throw new Error("claim token missing");

    await expect(
      retryPaymentReconciliationJob(database.db, {
        id: job.id,
        owner: "payment-warning-retry-owner",
        leaseToken: claimed.leaseToken,
        terminalNow: new Date("2030-05-01T00:01:00.000Z"),
        errorCode: "INVALID_WARNING",
        warnings,
      }),
    ).rejects.toBeInstanceOf(ProviderContractError);

    const persisted = await database.db.query.paymentReconciliationJobs.findFirst({
      where: eq(paymentReconciliationJobs.id, job.id),
    });
    expect(persisted).toMatchObject({
      state: "processing",
      attempts: 0,
      leaseToken: claimed.leaseToken,
    });
    expect(
      await database.db
        .select()
        .from(commerceReconciliationRuns)
        .where(eq(commerceReconciliationRuns.targetId, job.id)),
    ).toHaveLength(0);
  },
);

it.each(invalidWarningCases)(
  "rejects %s before operator review can persist provider warnings",
  async (_name, warnings) => {
    const claimNow = new Date("2030-05-01T00:00:00.000Z");
    const order = await seedOrder();
    const [job] = await database.db
      .insert(paymentReconciliationJobs)
      .values({ orderId: order.id, nextAttemptAt: claimNow })
      .returning();
    if (!job) throw new Error("reconciliation job insert failed");
    const [claimed] = await claimPaymentReconciliationJobs(database.db, {
      owner: "payment-warning-review-owner",
      now: claimNow,
    });
    if (!claimed?.leaseToken) throw new Error("claim token missing");

    await expect(
      operatorReviewPaymentReconciliationJob(database.db, {
        id: job.id,
        owner: "payment-warning-review-owner",
        leaseToken: claimed.leaseToken,
        terminalNow: new Date("2030-05-01T00:01:00.000Z"),
        reason: "warning contract invalid",
        warnings,
      }),
    ).rejects.toBeInstanceOf(ProviderContractError);

    const persisted = await database.db.query.paymentReconciliationJobs.findFirst({
      where: eq(paymentReconciliationJobs.id, job.id),
    });
    expect(persisted).toMatchObject({
      state: "processing",
      leaseToken: claimed.leaseToken,
    });
    expect(
      await database.db
        .select()
        .from(commerceReconciliationRuns)
        .where(eq(commerceReconciliationRuns.targetId, job.id)),
    ).toHaveLength(0);
  },
);

it("schedules retry backoff from terminal time and clears the live lease", async () => {
  const claimNow = new Date("2030-05-01T00:00:00.000Z");
  const terminalNow = new Date("2030-05-01T00:01:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, nextAttemptAt: claimNow })
    .returning();
  if (!job) throw new Error("reconciliation job insert failed");
  const [claimed] = await claimPaymentReconciliationJobs(database.db, {
    owner: "payment-retry-owner",
    now: claimNow,
  });
  if (!claimed?.leaseToken) throw new Error("claim token missing");

  const warnings = [
    {
      message: "Provider result may be delayed",
      layer: "payments",
      aiHint: "retry later",
      secretInternalDetail: "must not persist",
    },
  ];
  const retried = await retryPaymentReconciliationJob(database.db, {
    id: job.id,
    owner: "payment-retry-owner",
    leaseToken: claimed.leaseToken,
    terminalNow,
    errorCode: "PROVIDER_TIMEOUT",
    warnings,
  });

  expect(retried).toBe(true);
  const persisted = await database.db.query.paymentReconciliationJobs.findFirst({
    where: eq(paymentReconciliationJobs.id, job.id),
  });
  expect(persisted).toMatchObject({
    state: "pending",
    attempts: 1,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: "PROVIDER_TIMEOUT",
    nextAttemptAt: new Date("2030-05-01T00:01:02.000Z"),
    updatedAt: terminalNow,
  });

  const audits = await database.db
    .select()
    .from(commerceReconciliationRuns)
    .where(eq(commerceReconciliationRuns.targetId, job.id));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    dedupKey: `payment-reconciliation:${job.id}:${claimed.leaseToken}:retry`,
    targetType: "payment_reconciliation_job",
    actorType: "worker",
    result: "retry_scheduled",
    afterJson: {
      state: "pending",
      errorCode: "PROVIDER_TIMEOUT",
      warnings: [
        {
          message: "Provider result may be delayed",
          layer: "payments",
          aiHint: "retry later",
        },
      ],
    },
  });
});

it("quarantines a transient failure after the bounded final attempt", async () => {
  const claimNow = new Date("2030-05-01T00:00:00.000Z");
  const terminalNow = new Date("2030-05-01T00:01:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({
      orderId: order.id,
      attempts: 11,
      nextAttemptAt: claimNow,
    })
    .returning();
  if (!job) throw new Error("reconciliation job insert failed");
  const [claimed] = await claimPaymentReconciliationJobs(database.db, {
    owner: "payment-final-owner",
    now: claimNow,
  });
  if (!claimed?.leaseToken) throw new Error("claim token missing");

  const transitioned = await retryPaymentReconciliationJob(database.db, {
    id: job.id,
    owner: "payment-final-owner",
    leaseToken: claimed.leaseToken,
    terminalNow,
    errorCode: "PROVIDER_TIMEOUT",
  });

  expect(transitioned).toBe(true);
  const persisted = await database.db.query.paymentReconciliationJobs.findFirst({
    where: eq(paymentReconciliationJobs.id, job.id),
  });
  expect(persisted).toMatchObject({
    state: "dead_letter",
    attempts: 12,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: "PROVIDER_TIMEOUT",
    completedAt: terminalNow,
    updatedAt: terminalNow,
  });
  expect(
    await claimPaymentReconciliationJobs(database.db, {
      owner: "payment-after-dead-letter",
      now: new Date("2030-06-01T00:00:00.000Z"),
    }),
  ).toEqual([]);
});

it("writes one idempotent operator-review audit with allowlisted warnings", async () => {
  const claimNow = new Date("2030-05-01T00:00:00.000Z");
  const terminalNow = new Date("2030-05-01T00:01:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, nextAttemptAt: claimNow })
    .returning();
  if (!job) throw new Error("reconciliation job insert failed");
  const [claimed] = await claimPaymentReconciliationJobs(database.db, {
    owner: "payment-review-owner",
    now: claimNow,
  });
  if (!claimed?.leaseToken) throw new Error("claim token missing");
  const input = {
    id: job.id,
    owner: "payment-review-owner",
    leaseToken: claimed.leaseToken,
    terminalNow,
    reason: "payment-level period unavailable",
    warnings: [
      {
        message: "Subscription relation returned",
        layer: "payments",
        aiHint: "operator review",
        secretInternalDetail: "must not persist",
      },
    ],
  } as const;

  expect(await operatorReviewPaymentReconciliationJob(database.db, input)).toBe(true);
  expect(await operatorReviewPaymentReconciliationJob(database.db, input)).toBe(false);

  const persisted = await database.db.query.paymentReconciliationJobs.findFirst({
    where: eq(paymentReconciliationJobs.id, job.id),
  });
  expect(persisted).toMatchObject({
    state: "operator_review",
    operatorReviewReason: "payment-level period unavailable",
    completedAt: terminalNow,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
  });
  const audits = await database.db
    .select()
    .from(commerceReconciliationRuns)
    .where(eq(commerceReconciliationRuns.targetId, job.id));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    dedupKey: `payment-reconciliation:${job.id}:${claimed.leaseToken}:operator-review`,
    targetType: "payment_reconciliation_job",
    actorType: "worker",
    result: "operator_review_required",
    afterJson: {
      state: "operator_review",
      reason: "payment-level period unavailable",
      warnings: [
        {
          message: "Subscription relation returned",
          layer: "payments",
          aiHint: "operator review",
        },
      ],
    },
  });
});
