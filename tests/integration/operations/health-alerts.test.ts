import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { GET as live } from "@/app/api/health/live/route";
import { createDatabaseClient } from "@/platform/database/client";
import {
  authSecurityEvents,
  creditReconciliationIncidents,
  fulfillmentJobs,
  paymentWebhookInbox,
} from "@/platform/database/schema";
import {
  DEFAULT_OPERATIONAL_ALERT_THRESHOLDS,
  evaluateOperationalAlerts,
} from "@/platform/observability/alerts";
import { checkReadiness } from "@/platform/observability/health";
import { collectOperationalAlertSnapshot } from "@/platform/observability/operational-snapshot";
import { inspectDeadLetters, retryDeadLetter } from "@/platform/operations/dead-letters";

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

it("liveness is dependency-free and discloses only status", async () => {
  const response = live();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("readiness checks database and migration history without leaking details", async () => {
  await expect(checkReadiness(database.db)).resolves.toEqual({ status: "ready" });

  const closed = createDatabaseClient(databaseUrl);
  await closed.close();
  await expect(checkReadiness(closed.db)).resolves.toEqual({
    status: "degraded",
    code: "dependency_unavailable",
  });
});

it("covers every required operational alert class with bounded payloads", () => {
  const thresholds = DEFAULT_OPERATIONAL_ALERT_THRESHOLDS;
  const alerts = evaluateOperationalAlerts({
    deadLettersCreated: 1,
    magicLinkRequests5m: thresholds.magicLinkRequests5m,
    invalidWebhookSignatures5m: thresholds.invalidWebhookSignatures5m,
    reconciliationMismatches: 1,
    jobBacklog: thresholds.jobBacklog,
    oldestJobAgeSeconds: thresholds.oldestJobAgeSeconds,
    providerFailures5m: thresholds.providerFailures5m,
    webhookRetentionBacklog: thresholds.webhookRetentionBacklog,
    oldestRetainedWebhookAgeSeconds: thresholds.oldestRetainedWebhookAgeSeconds,
  });

  expect(new Set(alerts.map((item) => item.code))).toEqual(
    new Set([
      "dead_letter_created",
      "magic_link_volume_spike",
      "webhook_invalid_signature_spike",
      "reconciliation_mismatch",
      "job_backlog_stale",
      "provider_outage_repeated",
      "webhook_retention_backlog_stale",
    ]),
  );
  expect(JSON.stringify(alerts)).not.toMatch(/email|userId|orderId|paymentId|sessionId/i);
});

it("alerts on durable open credit incidents without exposing incident data", async () => {
  const entityId = `private-grant-${crypto.randomUUID()}`;
  const detail = `private-detail-${crypto.randomUUID()}`;
  await database.db.insert(creditReconciliationIncidents).values({
    code: "GRANT_LEDGER_MISMATCH",
    entityId,
    detail,
  });

  const snapshot = await collectOperationalAlertSnapshot(database.db);
  const alerts = evaluateOperationalAlerts(snapshot);
  const reconciliationAlert = alerts.find((item) => item.code === "reconciliation_mismatch");
  expect(reconciliationAlert).toMatchObject({
    event: "operational_alert",
    code: "reconciliation_mismatch",
    severity: "critical",
    observedValue: 1,
    threshold: 1,
  });
  expect(JSON.stringify(reconciliationAlert)).not.toContain(entityId);
  expect(JSON.stringify(reconciliationAlert)).not.toContain(detail);
  expect(JSON.stringify(reconciliationAlert)).not.toContain("GRANT_LEDGER_MISMATCH");
});

it("measures retained webhook backlog and oldest retained payload age", async () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const oldest = new Date("2026-08-07T12:00:00Z");
  await database.db.insert(paymentWebhookInbox).values([
    {
      environment: "test",
      providerEventId: "retention-observability-oldest",
      dedupHash: "retention-observability-oldest-dedup",
      eventType: "unsupported_signed_event",
      signatureValid: true,
      normalizedPayloadJson: { eventId: "retention-observability-oldest" },
      payloadHash: "retention-observability-oldest-hash",
      payloadSizeBytes: 64,
      rawPayloadCiphertext: new Uint8Array([1, 2, 3]),
      rawPayloadKeyId: "test-key",
      rawPayloadExpiresAt: new Date("2026-08-08T12:00:00Z"),
      retentionClass: "unresolved_encrypted",
      state: "processed",
      receivedAt: oldest,
      processedAt: oldest,
    },
    {
      environment: "test",
      providerEventId: "retention-observability-newer",
      dedupHash: "retention-observability-newer-dedup",
      eventType: "unsupported_signed_event",
      signatureValid: true,
      normalizedPayloadJson: { eventId: "retention-observability-newer" },
      payloadHash: "retention-observability-newer-hash",
      payloadSizeBytes: 64,
      rawPayloadCiphertext: new Uint8Array([4, 5, 6]),
      rawPayloadKeyId: "test-key",
      rawPayloadExpiresAt: new Date("2026-08-10T12:00:00Z"),
      retentionClass: "unresolved_encrypted",
      state: "processed",
      receivedAt: new Date("2026-08-08T12:00:00Z"),
      processedAt: new Date("2026-08-08T12:00:00Z"),
    },
  ]);

  const snapshot = await collectOperationalAlertSnapshot(database.db, now);
  expect(snapshot.webhookRetentionBacklog).toBe(2);
  expect(snapshot.oldestRetainedWebhookAgeSeconds).toBe(2 * 24 * 60 * 60);
});

it("inspects dead letters without business payloads and requeues with immutable audit", async () => {
  const [dead] = await database.db
    .insert(fulfillmentJobs)
    .values({
      sourceType: "payment",
      sourceId: "private-source-id",
      operation: "grant:credits",
      idempotencyKey: `dead-letter-${crypto.randomUUID()}`,
      state: "dead_letter",
      attempts: 12,
      lastErrorCode: "ProviderUnavailable",
    })
    .returning();
  if (!dead) throw new Error("dead-letter fixture insert failed");

  const inspected = await inspectDeadLetters(database.db);
  const row = inspected.find((item) => item.id === dead.id);
  expect(row).toMatchObject({
    queue: "fulfillment",
    id: dead.id,
    attempts: 12,
    errorCode: "ProviderUnavailable",
  });
  expect(JSON.stringify(row)).not.toContain("private-source-id");

  await expect(
    retryDeadLetter(database.db, {
      queue: "fulfillment",
      id: dead.id,
      environment: "test",
      reason: "Operator verified provider recovery",
    }),
  ).resolves.toBe(true);

  const updated = await database.db.query.fulfillmentJobs.findFirst();
  expect(updated).toMatchObject({ state: "pending", attempts: 0, lastErrorCode: null });
  const audit = await database.db.query.authSecurityEvents.findFirst();
  expect(audit).toMatchObject({
    eventType: "dead_letter_retried",
    outcome: "accepted",
  });
  expect((audit?.details as Record<string, unknown> | undefined)?.recordId).toBe(dead.id);

  await expect(
    retryDeadLetter(database.db, {
      queue: "fulfillment",
      id: dead.id,
      environment: "test",
      reason: "A second retry must not mutate non-dead state",
    }),
  ).resolves.toBe(false);

  const audits = await database.db.select().from(authSecurityEvents);
  expect(audits).toHaveLength(1);
});
