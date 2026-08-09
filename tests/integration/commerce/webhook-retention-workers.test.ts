import { isNotNull, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { purgeExpiredWebhookPayloads } from "@/platform/commerce/application/purge-webhook-payloads";
import { getWebhookRetentionMetrics } from "@/platform/commerce/application/webhook-retention-metrics";
import { createDatabaseClient } from "@/platform/database/client";
import { paymentWebhookInbox } from "@/platform/database/schema";

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

it("multiple workers purge each expired encrypted payload once without exposing payload data", async () => {
  const now = new Date("2026-08-09T20:00:00Z");
  const receivedAt = new Date("2026-08-09T19:00:00Z");
  const rows = Array.from({ length: 18 }, (_, index) => ({
    environment: "test",
    providerEventId: `retention-event-${index}`,
    dedupHash: `retention-dedup-${index}`,
    eventType: "payment.updated",
    signatureValid: true,
    normalizedPayloadJson: {},
    payloadHash: `retention-payload-${index}`,
    payloadSizeBytes: 128,
    rawPayloadCiphertext: new Uint8Array([1, 2, 3, index]),
    rawPayloadKeyId: "test-retention-key-v1",
    rawPayloadExpiresAt: new Date("2026-08-09T19:59:00Z"),
    retentionClass: "transient_encrypted",
    state: "completed",
    receivedAt,
    processedAt: receivedAt,
  }));
  await database.db.insert(paymentWebhookInbox).values(rows);

  const before = await getWebhookRetentionMetrics(database.db, now);
  expect(before).toEqual({ retainedPayloads: 18, oldestRetainedPayloadAgeSeconds: 3600 });
  expect(JSON.stringify(before)).not.toMatch(
    /payloadHash|providerEventId|order|payment|user|email/i,
  );

  const processed = await Promise.all([
    purgeExpiredWebhookPayloads(database.db, { now, limit: 6 }),
    purgeExpiredWebhookPayloads(database.db, { now, limit: 6 }),
    purgeExpiredWebhookPayloads(database.db, { now, limit: 6 }),
  ]);
  expect(processed.reduce((sum, count) => sum + count, 0)).toBe(18);

  const remaining = await database.db
    .select({ count: sql<number>`count(*)::int` })
    .from(paymentWebhookInbox)
    .where(isNotNull(paymentWebhookInbox.rawPayloadCiphertext));
  expect(Number(remaining[0]?.count ?? 0)).toBe(0);

  const purged = await database.db.select().from(paymentWebhookInbox);
  expect(purged).toHaveLength(18);
  expect(purged.every((row) => row.rawPayloadCiphertext === null)).toBe(true);
  expect(purged.every((row) => row.rawPayloadKeyId === null)).toBe(true);
  expect(purged.every((row) => row.rawPayloadExpiresAt === null)).toBe(true);
  expect(purged.every((row) => row.rawPayloadPurgedAt?.getTime() === now.getTime())).toBe(true);

  await expect(getWebhookRetentionMetrics(database.db, now)).resolves.toEqual({
    retainedPayloads: 0,
    oldestRetainedPayloadAgeSeconds: 0,
  });
});
