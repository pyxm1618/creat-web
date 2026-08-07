import { timingSafeEqual } from "node:crypto";

import { accountDeletionService } from "@/platform/accounts/account-deletion-runtime";
import { env } from "@/platform/config/env";

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
    return new Response("Unauthorized", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }

  const result = await accountDeletionService.runDueBatch(10);
  return Response.json(result, {
    headers: { "cache-control": "no-store" },
  });
}
