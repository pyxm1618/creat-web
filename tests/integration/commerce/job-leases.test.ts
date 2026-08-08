import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  claimFulfillmentJobs,
  claimWebhookInbox,
} from "@/platform/commerce/application/job-leases";
import { createDatabaseClient } from "@/platform/database/client";
import { fulfillmentJobs, paymentWebhookInbox } from "@/platform/database/schema";

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
