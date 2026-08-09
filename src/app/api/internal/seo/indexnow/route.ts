import { z } from "zod";

import { routeRegistry } from "@/config/routes.config";
import { env } from "@/platform/config/env";
import {
  INDEXNOW_MAX_URLS,
  IndexNowSubmissionError,
  submitIndexNowUrls,
} from "@/platform/seo/indexnow";
import {
  authenticateInternalRequest,
  unauthorizedInternalResponse,
} from "@/platform/operations/authenticate-internal-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z
  .object({
    urls: z.array(z.string().trim().min(1)).min(1).max(INDEXNOW_MAX_URLS),
  })
  .strict();

function jsonError(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!authenticateInternalRequest(request, env.cronSecret)) return unauthorizedInternalResponse();
  if (!env.indexNowKey) return jsonError("indexnow_not_configured", 404);

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return jsonError("invalid_request", 400);
  }

  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return jsonError("invalid_request", 400);

  try {
    const result = await submitIndexNowUrls({
      canonicalOrigin: routeRegistry.site.canonicalOrigin,
      key: env.indexNowKey,
      urls: parsed.data.urls,
    });
    return Response.json(
      { accepted: true, statusCode: result.statusCode, submitted: result.submitted },
      { status: result.statusCode, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof IndexNowSubmissionError) {
      return jsonError("indexnow_upstream_failure", error.statusCode === 429 ? 503 : 502);
    }
    if (error instanceof Error) return jsonError("invalid_indexnow_submission", 400);
    return jsonError("indexnow_upstream_failure", 502);
  }
}
