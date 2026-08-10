import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/platform/auth/auth";
import { isBlockedPublicAuthRequest } from "@/platform/auth/public-route-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, method: "GET" | "POST"): Promise<Response> {
  if (isBlockedPublicAuthRequest(request)) return new Response("Not Found", { status: 404 });
  const auth = getAuth();
  if (!auth) return new Response("Not Found", { status: 404 });
  const handlers = toNextJsHandler(auth);
  return handlers[method](request);
}

export function GET(request: Request): Promise<Response> {
  return handle(request, "GET");
}

export function POST(request: Request): Promise<Response> {
  return handle(request, "POST");
}
