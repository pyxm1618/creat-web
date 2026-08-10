import { and, eq, isNotNull, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { InvalidWebhookSignatureError } from "@/platform/commerce/application/errors";
import { ingestProviderWebhook } from "@/platform/commerce/application/ingest-provider-webhook";
import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import {
  purgeExpiredWebhookPayloads,
  purgeRejectedWebhookDiagnostics,
} from "@/platform/commerce/application/purge-webhook-payloads";
import { payloadHash } from "@/platform/commerce/application/webhook-retention";
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

const invalidSignatureProvider: PaymentProvider = {
  name: "invalid-signature-test-provider",
  capabilities: { oneTime: true, subscriptions: false, partialRefunds: false },
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
  async requestRefund() {
    throw new Error("not used");
  },
  async getPayment() {
    return null;
  },
  async verifyAndNormalizeWebhook() {
    throw new InvalidWebhookSignatureError();
  },
};

async function ingestInvalidPayload(body: Uint8Array, now: Date) {
  return ingestProviderWebhook({
    database: database.db,
    provider: invalidSignatureProvider,
    environment: "test",
    rawBody: body,
    signature: "invalid",
    retention: {},
    now,
  });
}

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

it("buckets distinct invalid bodies into one diagnostic per environment and UTC minute", async () => {
  const now = new Date("2026-08-09T20:00:10.000Z");
  const bodyA = new TextEncoder().encode('{"invalid":"a"}');
  const bodyB = new TextEncoder().encode('{"invalid":"b"}');

  expect(await ingestInvalidPayload(bodyA, now)).toMatchObject({
    accepted: false,
    duplicate: false,
  });
  expect(await ingestInvalidPayload(bodyB, new Date(now.getTime() + 20_000))).toMatchObject({
    accepted: false,
    duplicate: true,
  });

  const rows = await database.db
    .select()
    .from(paymentWebhookInbox)
    .where(
      and(
        eq(paymentWebhookInbox.providerEventId, "invalid:test:2026-08-09T20:00"),
        eq(paymentWebhookInbox.state, "rejected"),
      ),
    );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    signatureValid: false,
    normalizedPayloadJson: {},
    payloadHash: payloadHash(bodyA),
    payloadSizeBytes: bodyA.byteLength,
  });
  expect(rows[0]?.rawPayloadCiphertext).toBeNull();
  expect(rows[0]?.rawPayloadKeyId).toBeNull();
});

it("deletes a rejected invalid-signature diagnostic after 24 hours", async () => {
  await database.db
    .delete(paymentWebhookInbox)
    .where(
      and(eq(paymentWebhookInbox.signatureValid, false), eq(paymentWebhookInbox.state, "rejected")),
    );
  const now = new Date("2026-08-09T21:00:10.000Z");
  await ingestInvalidPayload(new TextEncoder().encode('{"invalid":"expired"}'), now);

  expect(
    await purgeRejectedWebhookDiagnostics(database.db, {
      now: new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1),
    }),
  ).toBe(1);
  const rows = await database.db
    .select({ id: paymentWebhookInbox.id })
    .from(paymentWebhookInbox)
    .where(eq(paymentWebhookInbox.providerEventId, "invalid:test:2026-08-09T21:00"));
  expect(rows).toHaveLength(0);
});
