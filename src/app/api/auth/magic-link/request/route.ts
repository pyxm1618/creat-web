import { z } from "zod";

import { featuresConfig } from "@/config/features.config";
import { createAuthAttemptLimiter } from "@/platform/auth/attempt-rate-limit";
import { getAuth } from "@/platform/auth/auth";
import { assertAllowedRelativeCallback } from "@/platform/auth/callback-url";
import { extractTrustedClientIp } from "@/platform/auth/client-ip";
import { normalizeEmail } from "@/platform/auth/email-normalization";
import { verifyTurnstileToken } from "@/platform/auth/turnstile";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";
import { recordOperationalSecurityEvent } from "@/platform/observability/operational-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  email: z.email().max(320),
  returnTo: z.string().min(1).max(512),
  turnstileToken: z.string().min(1).max(2048),
});

export async function POST(request: Request): Promise<Response> {
  if (!featuresConfig.auth.enabled || !featuresConfig.auth.magicLink) {
    return new Response("Not Found", { status: 404 });
  }
  const auth = getAuth();
  if (!auth || !env.betterAuthSecret || !env.turnstileSecretKey) {
    throw new Error("Authentication security configuration is incomplete");
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
  await recordOperationalSecurityEvent(db, {
    eventType: "magic_link_request",
    outcome: "accepted",
  }).catch(() => undefined);

  try {
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

  const deployed = env.appEnv === "staging" || env.appEnv === "production";
  const turnstile = await verifyTurnstileToken({
    token: parsed.data.turnstileToken,
    secretKey: env.turnstileSecretKey,
    remoteIp: clientIp,
    ...(deployed
      ? {
          expectedAction: "magic-link",
          expectedHostname: new URL(env.appOrigin).hostname,
        }
      : {}),
  });
  if (!turnstile.ok) {
    if (turnstile.reason === "unavailable") {
      await recordOperationalSecurityEvent(db, {
        eventType: "provider_failure",
        outcome: "failure",
        details: { provider: "turnstile" },
      }).catch(() => undefined);
    }
    return Response.json(
      { error: turnstile.reason === "unavailable" ? "challenge_unavailable" : "challenge_failed" },
      { status: turnstile.reason === "unavailable" ? 503 : 403 },
    );
  }

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
    await recordOperationalSecurityEvent(db, {
      eventType: "provider_failure",
      outcome: "failure",
      details: { provider: env.emailTransport === "resend" ? "resend" : "email_test_transport" },
    }).catch(() => undefined);
    return Response.json({ error: "request_unavailable" }, { status: 503 });
  }

  return Response.json(
    { status: "accepted" },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
