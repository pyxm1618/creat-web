import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  purgeExpiredWebhookPayloads,
  purgeRejectedWebhookDiagnostics,
} from "@/platform/commerce/application/purge-webhook-payloads";
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

it("two purge workers lease disjoint expired payloads and replay idempotently", async () => {
  const receivedAt = new Date("2026-08-01T00:00:00Z");
  const expiresAt = new Date("2026-08-02T00:00:00Z");
  const purgeAt = new Date("2026-08-03T00:00:00Z");

  await database.db.insert(paymentWebhookInbox).values(
    Array.from({ length: 12 }, (_, index) => ({
      environment: "test",
      providerEventId: `purge-race-event-${index}`,
      dedupHash: `purge-race-dedup-${index}`,
      eventType: "unsupported_signed_event",
      signatureValid: true,
      normalizedPayloadJson: { eventId: `purge-race-event-${index}` },
      payloadHash: `purge-race-hash-${index}`,
      payloadSizeBytes: 64,
      rawPayloadCiphertext: new Uint8Array([index + 1, 2, 3]),
      rawPayloadKeyId: "test-key",
      rawPayloadExpiresAt: expiresAt,
      retentionClass: "unresolved_encrypted",
      state: "processed",
      receivedAt,
      processedAt: receivedAt,
    })),
  );

  const [workerA, workerB] = await Promise.all([
    purgeExpiredWebhookPayloads(database.db, { now: purgeAt, limit: 6 }),
    purgeExpiredWebhookPayloads(database.db, { now: purgeAt, limit: 6 }),
  ]);

  expect(workerA + workerB).toBe(12);

  const remaining = await database.db
    .select({ id: paymentWebhookInbox.id })
    .from(paymentWebhookInbox)
    .where(isNotNull(paymentWebhookInbox.rawPayloadCiphertext));
  expect(remaining).toHaveLength(0);

  expect(await purgeExpiredWebhookPayloads(database.db, { now: purgeAt, limit: 12 })).toBe(0);
});

it("active legal hold is not purged", async () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const [held] = await database.db
    .insert(paymentWebhookInbox)
    .values({
      environment: "test",
      providerEventId: "held-event",
      dedupHash: "held-dedup",
      eventType: "unsupported_signed_event",
      signatureValid: true,
      normalizedPayloadJson: { eventId: "held-event" },
      payloadHash: "held-hash",
      payloadSizeBytes: 64,
      rawPayloadCiphertext: new Uint8Array([9, 8, 7]),
      rawPayloadKeyId: "test-key",
      rawPayloadExpiresAt: new Date("2026-08-02T00:00:00Z"),
      retentionClass: "unresolved_encrypted",
      legalHoldReviewAt: new Date("2026-09-01T00:00:00Z"),
      state: "processed",
      receivedAt: new Date("2026-08-01T00:00:00Z"),
      processedAt: new Date("2026-08-01T00:00:00Z"),
    })
    .returning();
  if (!held) throw new Error("held webhook insert failed");

  expect(await purgeExpiredWebhookPayloads(database.db, { now, limit: 20 })).toBe(0);
  const stored = await database.db.query.paymentWebhookInbox.findFirst({
    where: (table, { eq }) => eq(table.id, held.id),
  });
  expect(stored?.rawPayloadCiphertext).not.toBeNull();
  expect(stored?.rawPayloadPurgedAt).toBeNull();
});

it("concurrent workers delete disjoint expired rejected diagnostics and retain recent rows", async () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const expiredAt = new Date(now.getTime() - 24 * 60 * 60 * 1000 - 1);
  const recentAt = new Date(now.getTime() - 24 * 60 * 60 * 1000 + 1);
  await database.db.insert(paymentWebhookInbox).values([
    ...Array.from({ length: 12 }, (_, index) => ({
      environment: "test",
      providerEventId: `invalid:test:2026-08-08T${String(index).padStart(2, "0")}:00`,
      dedupHash: `expired-invalid-dedup-${index}`,
      eventType: "invalid_signature",
      signatureValid: false,
      normalizedPayloadJson: {},
      payloadHash: `expired-invalid-payload-${index}`,
      payloadSizeBytes: 32,
      retentionClass: "invalid_signature",
      state: "rejected",
      receivedAt: expiredAt,
      processedAt: expiredAt,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      environment: "test",
      providerEventId: `invalid:test:2026-08-10T1${index}:00`,
      dedupHash: `recent-invalid-dedup-${index}`,
      eventType: "invalid_signature",
      signatureValid: false,
      normalizedPayloadJson: {},
      payloadHash: `recent-invalid-payload-${index}`,
      payloadSizeBytes: 32,
      retentionClass: "invalid_signature",
      state: "rejected",
      receivedAt: recentAt,
      processedAt: recentAt,
    })),
  ]);

  const [workerA, workerB] = await Promise.all([
    purgeRejectedWebhookDiagnostics(database.db, { now, limit: 6 }),
    purgeRejectedWebhookDiagnostics(database.db, { now, limit: 6 }),
  ]);
  expect(workerA + workerB).toBe(12);

  const remaining = await database.db
    .select({ id: paymentWebhookInbox.id })
    .from(paymentWebhookInbox)
    .where(
      and(eq(paymentWebhookInbox.signatureValid, false), eq(paymentWebhookInbox.state, "rejected")),
    );
  expect(remaining).toHaveLength(2);
  expect(await purgeRejectedWebhookDiagnostics(database.db, { now, limit: 12 })).toBe(0);
});
