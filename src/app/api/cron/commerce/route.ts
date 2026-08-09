import { randomUUID } from "node:crypto";

import { purgeExpiredWebhookPayloads } from "@/platform/commerce/application/purge-webhook-payloads";
import { reconcileStaleRefunds } from "@/platform/commerce/application/reconcile-stale-refunds";
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

const COMMERCE_BATCH_LIMIT = 20;
const COMMERCE_RUNTIME_MS = 45_000;

export async function GET(request: Request): Promise<Response> {
  if (!authenticateInternalRequest(request, env.cronSecret)) return unauthorizedInternalResponse();
  const commerce = await getCommerceRuntime();
  if (!commerce) return new Response("Not Found", { status: 404 });

  const result = await runBoundedJob({
    batchLimit: COMMERCE_BATCH_LIMIT,
    maxRuntimeMs: COMMERCE_RUNTIME_MS,
    run: async (job) => {
      const worker = await runCommerceWorker({
        database: commerce.database,
        provider: commerce.provider,
        fulfillment: commerce.fulfillment,
        owner: `cron:${randomUUID()}`,
        limit: job.batchLimit,
      });
      job.assertWithinBudget();

      let remaining = Math.max(0, job.batchLimit - worker.attempted);
      const staleRefundsReconciled =
        remaining > 0 && job.canContinue(2_000)
          ? await reconcileStaleRefunds(commerce.database, { limit: remaining })
          : 0;
      remaining = Math.max(0, remaining - staleRefundsReconciled);
      job.assertWithinBudget();

      const purgedPayloads =
        remaining > 0 && job.canContinue(2_000)
          ? await purgeExpiredWebhookPayloads(commerce.database, { limit: remaining })
          : 0;
      job.assertWithinBudget();
      return { ...worker, staleRefundsReconciled, purgedPayloads };
    },
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
