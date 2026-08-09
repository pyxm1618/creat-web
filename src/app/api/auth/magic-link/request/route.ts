import { z } from "zod";

import { featuresConfig } from "@/config/features.config";
import { createAuthAttemptLimiter } from "@/platform/auth/attempt-rate-limit";
import { getAuth } from "@/platform/auth/auth";
import { assertAllowedRelativeCallback } from "@/platform/auth/callback-url";
import { extractTrustedClientIp } from "@/platform/auth/client-ip";
import { normalizeEmail } from "@/platform/auth/email-normalization";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  email: z.email().max(320),
  returnTo: z.string().min(1).max(512),
});

export async function POST(request: Request): Promise<Response> {
  if (!featuresConfig.auth.enabled || !featuresConfig.auth.magicLink) {
    return new Response("Not Found", { status: 404 });
  }
  const auth = getAuth();
  if (!auth || !env.betterAuthSecret) {
    throw new Error("Better Auth secret is required for enabled magic-link requests");
  }
  const limiter = createAuthAttemptLimiter(db, env.betterAuthSecret);

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

  let returnTo: string;
  try {
    returnTo = assertAllowedRelativeCallback(parsed.data.returnTo);
  } catch {
    return Response.json({ error: "invalid_callback" }, { status: 400 });
  }

  const email = normalizeEmail(parsed.data.email);
  const clientIp = extractTrustedClientIp(request.headers, env.appEnv);
  const now = new Date();

  try {
    await limiter.consume({
      scope: "magic-link-send-email-burst",
      identifiers: [`email:${email}`],
      windowMs: 10 * 60 * 1000,
      max: 3,
      now,
    });
    await limiter.consume({
      scope: "magic-link-send-email-daily",
      identifiers: [`email:${email}`],
      windowMs: 24 * 60 * 60 * 1000,
      max: 10,
      now,
    });
    await limiter.consume({
      scope: "magic-link-send-ip-burst",
      identifiers: [`ip:${clientIp}`],
      windowMs: 60 * 1000,
      max: 10,
      now,
    });
    await limiter.consume({
      scope: "magic-link-send-ip-daily",
      identifiers: [`ip:${clientIp}`],
      windowMs: 24 * 60 * 60 * 1000,
      max: 50,
      now,
    });
  } catch {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    await auth.api.signInMagicLink({
      body: {
        email,
        callbackURL: returnTo,
        errorCallbackURL: "/sign-in?error=magic-link",
        metadata: { returnTo },
      },
      headers: request.headers,
    });
  } catch {
    return Response.json({ error: "request_unavailable" }, { status: 503 });
  }

  return Response.json(
    { status: "accepted" },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
