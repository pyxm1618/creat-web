import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  claimCommerceCommandJobs,
  claimFulfillmentJobs,
  claimWebhookInbox,
} from "@/platform/commerce/application/job-leases";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceCommandJobs,
  fulfillmentJobs,
  paymentWebhookInbox,
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
