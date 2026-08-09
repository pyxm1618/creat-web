import { randomUUID } from "node:crypto";

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
    run: async () =>
      runCommerceWorker({
        database: commerce.database,
        provider: commerce.provider,
        fulfillment: commerce.fulfillment,
        owner: `internal-commerce:${randomUUID()}`,
      }),
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
