import { isNotNull, sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { paymentWebhookInbox } from "@/platform/database/commerce-schema";

export type WebhookRetentionMetrics = Readonly<{
  retainedPayloads: number;
  oldestRetainedPayloadAgeSeconds: number;
}>;

function parseDatabaseTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error("invalid webhook retention timestamp");
  return parsed;
}

export async function getWebhookRetentionMetrics(
  database: DatabaseClient,
  now = new Date(),
): Promise<WebhookRetentionMetrics> {
  const [row] = await database
    .select({
      retainedPayloads: sql<number>`count(*)::int`,
      oldestReceivedAt: sql<unknown>`min(${paymentWebhookInbox.receivedAt})`,
    })
    .from(paymentWebhookInbox)
    .where(isNotNull(paymentWebhookInbox.rawPayloadCiphertext));

  const retainedPayloads = Number(row?.retainedPayloads ?? 0);
  const oldestReceivedAt = parseDatabaseTimestamp(row?.oldestReceivedAt);
  return {
    retainedPayloads,
    oldestRetainedPayloadAgeSeconds: oldestReceivedAt
      ? Math.max(0, Math.floor((now.getTime() - oldestReceivedAt.getTime()) / 1000))
      : 0,
  };
}
