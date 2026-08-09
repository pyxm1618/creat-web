import { randomUUID } from "node:crypto";

import { featuresConfig } from "@/config/features.config";
import { expireGrants, expireReservations } from "@/platform/credits/application/credit-service";
import { runCreditFinalizationWorker } from "@/platform/credits/application/finalization-worker";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";
import {
  authenticateInternalRequest,
  unauthorizedInternalResponse,
} from "@/platform/operations/authenticate-internal-request";
import { runBoundedJob } from "@/platform/operations/run-bounded-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!authenticateInternalRequest(request, env.cronSecret)) return unauthorizedInternalResponse();
  if (!featuresConfig.commerce.credits) return new Response("Not Found", { status: 404 });

  const result = await runBoundedJob({
    batchLimit: 50,
    maxRuntimeMs: 45_000,
    run: async (job) => {
      const expiredReservations = await expireReservations(db, { limit: job.batchLimit });
      job.assertWithinBudget();
      const finalized = job.canContinue(2_000)
        ? await runCreditFinalizationWorker(db, {
            owner: `internal-credits:${randomUUID()}`,
            limit: job.batchLimit,
          })
        : { completed: 0, deferred: 0 };
      job.assertWithinBudget();
      const expiredGrants = job.canContinue(2_000)
        ? await expireGrants(db, { limit: job.batchLimit })
        : 0;
      return { expiredReservations, finalized, expiredGrants };
    },
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
