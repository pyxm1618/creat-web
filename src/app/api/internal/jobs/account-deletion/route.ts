import { getAccountDeletionService } from "@/platform/accounts/account-deletion-runtime";
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
  const service = getAccountDeletionService();
  if (!service) return new Response("Not Found", { status: 404 });

  const result = await runBoundedJob({
    batchLimit: 10,
    maxRuntimeMs: 45_000,
    run: async (job) => service.runDueBatch(job.batchLimit),
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
