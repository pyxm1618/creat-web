import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { getWebhookRetentionMetrics } from "@/platform/commerce/application/webhook-retention-metrics";
import type { DatabaseClient } from "@/platform/database/client";
import {
  accountDeletionRequests,
  authSecurityEvents,
  commerceCommandJobs,
  commerceReconciliationRuns,
  creditFinalizationJobs,
  fulfillmentJobs,
  paymentWebhookInbox,
} from "@/platform/database/schema";

import type { OperationalAlertSnapshot } from "./alerts";

type QueueSnapshot = { readonly count: number; readonly oldestAt: Date | null };

async function queueSnapshot(
  database: DatabaseClient,
  table: "webhook" | "fulfillment" | "commerce_command" | "credit_finalization" | "account_deletion",
): Promise<QueueSnapshot> {
  if (table === "webhook") {
    const [row] = await database
      .select({
        count: sql<number>`count(*)::int`,
        oldestAt: sql<Date | null>`min(${paymentWebhookInbox.receivedAt})`,
      })
      .from(paymentWebhookInbox)
      .where(inArray(paymentWebhookInbox.state, ["pending", "retry", "processing"]));
    return { count: Number(row?.count ?? 0), oldestAt: row?.oldestAt ?? null };
  }
  if (table === "fulfillment") {
    const [row] = await database
      .select({
        count: sql<number>`count(*)::int`,
        oldestAt: sql<Date | null>`min(${fulfillmentJobs.createdAt})`,
      })
      .from(fulfillmentJobs)
      .where(inArray(fulfillmentJobs.state, ["pending", "processing"]));
    return { count: Number(row?.count ?? 0), oldestAt: row?.oldestAt ?? null };
  }
  if (table === "commerce_command") {
    const [row] = await database
      .select({
        count: sql<number>`count(*)::int`,
        oldestAt: sql<Date | null>`min(${commerceCommandJobs.createdAt})`,
      })
      .from(commerceCommandJobs)
      .where(inArray(commerceCommandJobs.state, ["pending", "processing"]));
    return { count: Number(row?.count ?? 0), oldestAt: row?.oldestAt ?? null };
  }
  if (table === "credit_finalization") {
    const [row] = await database
      .select({
        count: sql<number>`count(*)::int`,
        oldestAt: sql<Date | null>`min(${creditFinalizationJobs.createdAt})`,
      })
      .from(creditFinalizationJobs)
      .where(inArray(creditFinalizationJobs.state, ["pending", "processing"]));
    return { count: Number(row?.count ?? 0), oldestAt: row?.oldestAt ?? null };
  }

  const [row] = await database
    .select({
      count: sql<number>`count(*)::int`,
      oldestAt: sql<Date | null>`min(${accountDeletionRequests.createdAt})`,
    })
    .from(accountDeletionRequests)
    .where(inArray(accountDeletionRequests.status, ["pending", "processing", "failed"]));
  return { count: Number(row?.count ?? 0), oldestAt: row?.oldestAt ?? null };
}

async function scalarCount<T>(query: Promise<T[]>): Promise<number> {
  const rows = (await query) as Array<{ count?: number }>;
  return Number(rows[0]?.count ?? 0);
}

export async function collectOperationalAlertSnapshot(
  database: DatabaseClient,
  now = new Date(),
): Promise<OperationalAlertSnapshot> {
  const cutoff = new Date(now.getTime() - 5 * 60 * 1000);

  const [
    magicLinkRequests5m,
    invalidWebhookSignatures5m,
    reconciliationMismatches,
    providerFailures5m,
    deadLettersCreated,
    webhookRetention,
    ...queues
  ] = await Promise.all([
    scalarCount(
      database
        .select({ count: sql<number>`count(*)::int` })
        .from(authSecurityEvents)
        .where(
          and(
            eq(authSecurityEvents.eventType, "magic_link_request"),
            gte(authSecurityEvents.createdAt, cutoff),
          ),
        ),
    ),
    scalarCount(
      database
        .select({ count: sql<number>`count(*)::int` })
        .from(paymentWebhookInbox)
        .where(
          and(
            eq(paymentWebhookInbox.signatureValid, false),
            gte(paymentWebhookInbox.receivedAt, cutoff),
          ),
        ),
    ),
    scalarCount(
      database
        .select({ count: sql<number>`count(*)::int` })
        .from(commerceReconciliationRuns)
        .where(
          and(
            eq(commerceReconciliationRuns.result, "operator_review_required"),
            gte(commerceReconciliationRuns.createdAt, cutoff),
          ),
        ),
    ),
    scalarCount(
      database
        .select({ count: sql<number>`count(*)::int` })
        .from(authSecurityEvents)
        .where(
          and(
            eq(authSecurityEvents.eventType, "provider_failure"),
            gte(authSecurityEvents.createdAt, cutoff),
          ),
        ),
    ),
    scalarCount(
      database
        .select({ count: sql<number>`count(*)::int` })
        .from(authSecurityEvents)
        .where(
          and(
            eq(authSecurityEvents.eventType, "dead_letter_created"),
            gte(authSecurityEvents.createdAt, cutoff),
          ),
        ),
    ),
    getWebhookRetentionMetrics(database, now),
    queueSnapshot(database, "webhook"),
    queueSnapshot(database, "fulfillment"),
    queueSnapshot(database, "commerce_command"),
    queueSnapshot(database, "credit_finalization"),
    queueSnapshot(database, "account_deletion"),
  ]);

  const jobBacklog = queues.reduce((sum, queue) => sum + queue.count, 0);
  const oldestAt = queues.reduce<Date | null>((oldest, queue) => {
    if (!queue.oldestAt) return oldest;
    if (!oldest || queue.oldestAt < oldest) return queue.oldestAt;
    return oldest;
  }, null);
  const oldestJobAgeSeconds = oldestAt
    ? Math.max(0, Math.floor((now.getTime() - oldestAt.getTime()) / 1000))
    : 0;

  return {
    deadLettersCreated,
    magicLinkRequests5m,
    invalidWebhookSignatures5m,
    reconciliationMismatches,
    jobBacklog,
    oldestJobAgeSeconds,
    providerFailures5m,
    webhookRetentionBacklog: webhookRetention.retainedPayloads,
    oldestRetainedWebhookAgeSeconds: webhookRetention.oldestRetainedPayloadAgeSeconds,
  };
}
