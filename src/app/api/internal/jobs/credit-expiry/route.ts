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
      let remaining = job.batchLimit;
      const expiredReservations = await expireReservations(db, { limit: remaining });
      remaining = Math.max(0, remaining - expiredReservations);
      job.assertWithinBudget();

      const finalized =
        remaining > 0 && job.canContinue(2_000)
          ? await runCreditFinalizationWorker(db, {
              owner: `internal-credits:${randomUUID()}`,
              limit: remaining,
            })
          : {
              claimed: 0,
              processed: 0,
              completed: 0,
              deferred: 0,
              deadLettered: 0,
              lostLease: 0,
            };
      remaining = Math.max(0, remaining - Math.max(finalized.claimed, finalized.processed));
      job.assertWithinBudget();

      const expiredGrants =
        remaining > 0 && job.canContinue(2_000) ? await expireGrants(db, { limit: remaining }) : 0;
      return { expiredReservations, finalized, expiredGrants };
    },
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
