import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { GET as live } from "@/app/api/health/live/route";
import { createDatabaseClient } from "@/platform/database/client";
import { authSecurityEvents, fulfillmentJobs } from "@/platform/database/schema";
import {
  DEFAULT_OPERATIONAL_ALERT_THRESHOLDS,
  evaluateOperationalAlerts,
} from "@/platform/observability/alerts";
import { checkReadiness } from "@/platform/observability/health";
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
  });

  expect(new Set(alerts.map((item) => item.code))).toEqual(
    new Set([
      "dead_letter_created",
      "magic_link_volume_spike",
      "webhook_invalid_signature_spike",
      "reconciliation_mismatch",
      "job_backlog_stale",
      "provider_outage_repeated",
    ]),
  );
  expect(JSON.stringify(alerts)).not.toMatch(/email|userId|orderId|paymentId|sessionId/i);
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
