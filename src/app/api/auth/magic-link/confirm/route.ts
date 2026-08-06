import { z } from "zod";

import { assertAllowedRelativeCallback } from "@/platform/auth/callback-url";
import { auth } from "@/platform/auth/auth";
import { env } from "@/platform/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  token: z.string().min(32).max(2048),
  returnTo: z.string().min(1).max(512),
});

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

  return auth.api.magicLinkVerify({
    query: {
      token: parsed.data.token,
      callbackURL,
    },
    headers: request.headers,
    asResponse: true,
  });
}
