import { z } from "zod";

import { createAuthAttemptLimiter } from "@/platform/auth/attempt-rate-limit";
import { assertAllowedRelativeCallback } from "@/platform/auth/callback-url";
import { extractTrustedClientIp } from "@/platform/auth/client-ip";
import { auth } from "@/platform/auth/auth";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  token: z.string().min(32).max(2048),
  returnTo: z.string().min(1).max(512),
});

if (!env.betterAuthSecret) {
  throw new Error("Better Auth secret is required for magic-link confirmation");
}

const limiter = createAuthAttemptLimiter(db, env.betterAuthSecret);

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== env.appOrigin) {
    return Response.json({ error: "invalid_origin" }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "invalid_content_type" }, { status: 415 });
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  let callbackURL: string;
  try {
    callbackURL = assertAllowedRelativeCallback(parsed.data.returnTo);
  } catch {
    return Response.json({ error: "invalid_callback" }, { status: 400 });
  }

  const clientIp = extractTrustedClientIp(request.headers, env.appEnv);
  try {
    await limiter.consume({
      scope: "magic-link-confirm-token",
      identifiers: [`token:${parsed.data.token}`],
      windowMs: 10 * 60 * 1000,
      max: 5,
      now: new Date(),
    });
    await limiter.consume({
      scope: "magic-link-confirm-ip",
      identifiers: [`ip:${clientIp}`],
      windowMs: 60 * 1000,
      max: 10,
      now: new Date(),
    });
  } catch {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  return auth.api.magicLinkVerify({
    query: {
      token: parsed.data.token,
      callbackURL,
    },
    headers: request.headers,
    asResponse: true,
  });
}
