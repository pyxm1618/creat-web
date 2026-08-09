import { z } from "zod";

import { featuresConfig } from "@/config/features.config";
import { getAccountContext } from "@/platform/auth/account-context";
import { enqueueSubscriptionCommand } from "@/platform/commerce/application/commerce-commands";
import { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import { env } from "@/platform/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ subscriptionId: z.uuid() });

export async function POST(request: Request): Promise<Response> {
  if (!featuresConfig.commerce.enabled || !featuresConfig.commerce.subscriptions) return new Response("Not Found", { status: 404 });
  if (request.headers.get("origin") !== env.appOrigin) return Response.json({ error: "invalid_origin" }, { status: 403 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "invalid_content_type" }, { status: 415 });
  const account = await getAccountContext(request.headers);
  if (!account) return Response.json({ error: "authentication_required" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  const commerce = await getCommerceRuntime();
  if (!commerce) return new Response("Not Found", { status: 404 });
  try {
    const job = await enqueueSubscriptionCommand(commerce.database, {
      subjectId: account.subject.id,
      subscriptionId: parsed.data.subscriptionId,
      command: "subscription_cancel",
      idempotencyKey: request.headers.get("idempotency-key") ?? "",
    });
    return Response.json({ commandId: job.id, state: job.state }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("not found")) return Response.json({ error: "subscription_not_found" }, { status: 404 });
    if (message.includes("idempotency") || message.includes("current state")) return Response.json({ error: "invalid_subscription_command" }, { status: 409 });
    return Response.json({ error: "subscription_command_unavailable" }, { status: 503 });
  }
}
