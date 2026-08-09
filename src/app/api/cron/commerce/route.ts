import { randomUUID, timingSafeEqual } from "node:crypto";

import { purgeExpiredWebhookPayloads } from "@/platform/commerce/application/purge-webhook-payloads";
import { runCommerceWorker } from "@/platform/commerce/application/run-commerce-worker";
import { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import { env } from "@/platform/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  if (!env.cronSecret) return false;
  const expected = Buffer.from(`Bearer ${env.cronSecret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  }
  const commerce = await getCommerceRuntime();
  if (!commerce) return new Response("Not Found", { status: 404 });

  const worker = await runCommerceWorker({
    database: commerce.database,
    provider: commerce.provider,
    fulfillment: commerce.fulfillment,
    owner: `cron:${randomUUID()}`,
  });
  const purgedPayloads = await purgeExpiredWebhookPayloads(commerce.database);
  return Response.json({ ...worker, purgedPayloads }, { headers: { "cache-control": "no-store" } });
}
