import { randomUUID } from "node:crypto";

import { featuresConfig } from "@/config/features.config";
import { expireGrants, expireReservations } from "@/platform/credits/application/credit-service";
import { runCreditFinalizationWorker } from "@/platform/credits/application/finalization-worker";
import { reconcileCreditLedgerBatch } from "@/platform/credits/application/reconcile-credit-ledger";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";
import {
  authenticateInternalRequest,
  unauthorizedInternalResponse,
} from "@/platform/operations/authenticate-internal-request";
import { runBoundedJob } from "@/platform/operations/run-bounded-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CREDIT_BATCH_LIMIT = 50;
const CREDIT_RUNTIME_MS = 45_000;

export async function GET(request: Request): Promise<Response> {
  if (!authenticateInternalRequest(request, env.cronSecret)) return unauthorizedInternalResponse();
  if (!featuresConfig.commerce.credits) return new Response("Not Found", { status: 404 });

  const result = await runBoundedJob({
    batchLimit: CREDIT_BATCH_LIMIT,
    maxRuntimeMs: CREDIT_RUNTIME_MS,
    run: async (job) => {
      let remaining = job.batchLimit;
      const expiredReservations = await expireReservations(db, { limit: remaining });
      remaining = Math.max(0, remaining - expiredReservations);
      job.assertWithinBudget();
      const finalized =
        remaining > 0 && job.canContinue(2_000)
          ? await runCreditFinalizationWorker(db, {
              owner: `credits:${randomUUID()}`,
              limit: remaining,
            })
          : { completed: 0, deferred: 0 };
      remaining = Math.max(0, remaining - finalized.completed - finalized.deferred);
      job.assertWithinBudget();
      const expiredGrants =
        remaining > 0 && job.canContinue(2_000) ? await expireGrants(db, { limit: remaining }) : 0;
      remaining = Math.max(0, remaining - expiredGrants);
      job.assertWithinBudget();
      const reconciliation =
        remaining > 0 && job.canContinue(2_000)
          ? await reconcileCreditLedgerBatch(db, {
              limit: remaining,
              signal: job.signal,
              canContinue: job.canContinue,
            })
          : null;
      return {
        expiredReservations,
        finalized,
        expiredGrants,
        reconciliationIssues: reconciliation?.issues.length ?? 0,
        reconciliationProcessed: reconciliation?.processed ?? 0,
        reconciliationCycleComplete: reconciliation?.cycleComplete ?? false,
      };
    },
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
