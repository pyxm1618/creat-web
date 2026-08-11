import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  claimPaymentReconciliationJobs,
  completePaymentReconciliationJob,
  operatorReviewPaymentReconciliationJob,
  retryPaymentReconciliationJob,
} from "@/platform/commerce/application/job-leases";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceReconciliationRuns,
  commerceProducts,
  orders,
  paymentReconciliationJobs,
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
  await database.db.delete(commerceReconciliationRuns);
  await database.db.delete(paymentReconciliationJobs);
  await database.db.delete(orders);
  await database.db.delete(commerceProducts);
  await database.db.delete(accountSubjects);
});

async function seedOrder() {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `payment-reconciliation-${crypto.randomUUID()}`,
      version: 1,
      model: "one_time",
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
    "environment",
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
  expect(constraints.get("payment_reconciliation_job_environment_valid")).toContain("production");
  expect(constraints.get("payment_reconciliation_job_attempts_nonnegative")).toContain(">= 0");
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

  expect(indexes.get("payment_reconciliation_order_uq")).toContain("environment, order_id");
  expect(indexes.get("payment_reconciliation_due_idx")).toContain(
    "state, next_attempt_at, created_at",
  );
  expect(indexes.get("payment_reconciliation_reclaim_idx")).toContain("state, lease_expires_at");
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

it("allows only one concurrent claim for a due reconciliation job", async () => {
  const now = new Date("2030-05-01T00:00:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, environment: "test", nextAttemptAt: now })
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

it("changes the lease token when the same owner reclaims an expired job", async () => {
  const firstNow = new Date("2030-05-01T00:00:00.000Z");
  const reclaimNow = new Date("2030-05-01T00:05:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, environment: "test", nextAttemptAt: firstNow })
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
    .values({ orderId: order.id, environment: "test", nextAttemptAt: firstNow })
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

it("does not retry after the claimed lease naturally expires", async () => {
  const claimNow = new Date("2030-05-01T00:00:00.000Z");
  const terminalNow = new Date("2030-05-01T00:06:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, environment: "test", nextAttemptAt: claimNow })
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
});

it("schedules retry backoff from terminal time and clears the live lease", async () => {
  const claimNow = new Date("2030-05-01T00:00:00.000Z");
  const terminalNow = new Date("2030-05-01T00:01:00.000Z");
  const order = await seedOrder();
  const [job] = await database.db
    .insert(paymentReconciliationJobs)
    .values({ orderId: order.id, environment: "test", nextAttemptAt: claimNow })
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
      environment: "test",
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
    .values({ orderId: order.id, environment: "test", nextAttemptAt: claimNow })
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
