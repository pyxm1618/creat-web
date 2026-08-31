import { randomUUID } from "node:crypto";

import { purgeRejectedWebhookDiagnostics } from "@/platform/commerce/application/purge-webhook-payloads";
import { runCommerceWorker } from "@/platform/commerce/application/run-commerce-worker";
import { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import { env } from "@/platform/config/env";
import {
  authenticateInternalRequest,
  unauthorizedInternalResponse,
} from "@/platform/operations/authenticate-internal-request";
import { runBoundedJob } from "@/platform/operations/run-bounded-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!authenticateInternalRequest(request, env.cronSecret)) return unauthorizedInternalResponse();
  const commerce = await getCommerceRuntime();
  if (!commerce) return new Response("Not Found", { status: 404 });

  const result = await runBoundedJob({
    batchLimit: 20,
    maxRuntimeMs: 45_000,
    run: async (job) => {
      let workerClaimed = 0;
      const worker = await runCommerceWorker({
        database: commerce.database,
        provider: commerce.provider,
        fulfillment: commerce.fulfillment,
        owner: `internal-commerce:${randomUUID()}`,
        limit: job.batchLimit,
        onClaimed: (count) => {
          workerClaimed = count;
        },
      });
      job.assertWithinBudget();

      const remaining = Math.max(0, job.batchLimit - workerClaimed);
      const rejectedDiagnosticsPurged =
        remaining > 0 && job.canContinue(2_000)
          ? await purgeRejectedWebhookDiagnostics(commerce.database, { limit: remaining })
          : 0;
      job.assertWithinBudget();
      return { ...worker, rejectedDiagnosticsPurged };
    },
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
