import { getAccountDeletionService } from "@/platform/accounts/account-deletion-runtime";
import { env } from "@/platform/config/env";
import {
  authenticateInternalRequest,
  unauthorizedInternalResponse,
} from "@/platform/operations/authenticate-internal-request";
import { runBoundedJob } from "@/platform/operations/run-bounded-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCOUNT_DELETION_BATCH_LIMIT = 10;
const ACCOUNT_DELETION_RUNTIME_MS = 45_000;

export async function GET(request: Request): Promise<Response> {
  const accountDeletionService = getAccountDeletionService();
  if (!accountDeletionService) return new Response("Not Found", { status: 404 });
  if (!authenticateInternalRequest(request, env.cronSecret)) return unauthorizedInternalResponse();

  const result = await runBoundedJob({
    batchLimit: ACCOUNT_DELETION_BATCH_LIMIT,
    maxRuntimeMs: ACCOUNT_DELETION_RUNTIME_MS,
    run: async (job) => accountDeletionService.runDueBatch(job.batchLimit),
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
