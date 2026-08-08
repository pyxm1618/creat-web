import { randomUUID, timingSafeEqual } from "node:crypto";

import { expireGrants, expireReservations } from "@/platform/credits/application/credit-service";
import { runCreditFinalizationWorker } from "@/platform/credits/application/finalization-worker";
import { reconcileCreditLedger } from "@/platform/credits/application/reconcile-credit-ledger";
import { featuresConfig } from "@/config/features.config";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";

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
  if (!featuresConfig.commerce.credits) return new Response("Not Found", { status: 404 });

  const expiredReservations = await expireReservations(db);
  const finalized = await runCreditFinalizationWorker(db, { owner: `credits:${randomUUID()}` });
  const expiredGrants = await expireGrants(db);
  const issues = await reconcileCreditLedger(db);
  return Response.json(
    {
      expiredReservations,
      finalized,
      expiredGrants,
      reconciliationIssues: issues.length,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
