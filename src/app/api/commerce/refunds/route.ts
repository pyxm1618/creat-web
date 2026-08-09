import { z } from "zod";

import { featuresConfig } from "@/config/features.config";
import { getAccountContext } from "@/platform/auth/account-context";
import { enqueueRefundRequest } from "@/platform/commerce/application/commerce-commands";
import { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import { parseDisplayAmount } from "@/platform/commerce/domain/money";
import { env } from "@/platform/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  paymentId: z.uuid(),
  amount: z.string().regex(/^\d+(?:\.\d+)?$/),
  currency: z.string().trim().length(3),
  reason: z.string().trim().min(3).max(500),
});

export async function POST(request: Request): Promise<Response> {
  if (!featuresConfig.commerce.enabled) return new Response("Not Found", { status: 404 });
  if (request.headers.get("origin") !== env.appOrigin) return Response.json({ error: "invalid_origin" }, { status: 403 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "invalid_content_type" }, { status: 415 });
  const account = await getAccountContext(request.headers);
  if (!account) return Response.json({ error: "authentication_required" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  const commerce = await getCommerceRuntime();
  if (!commerce) return new Response("Not Found", { status: 404 });
  try {
    const refund = await enqueueRefundRequest(commerce.database, {
      subjectId: account.subject.id,
      paymentId: parsed.data.paymentId,
      environment: commerce.environment,
      amount: parseDisplayAmount(parsed.data.amount, parsed.data.currency),
      reason: parsed.data.reason,
      idempotencyKey: request.headers.get("idempotency-key") ?? "",
    });
    return Response.json({ refundId: refund.id, status: refund.status }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("not found")) return Response.json({ error: "payment_not_found" }, { status: 404 });
    if (message.includes("refund") || message.includes("idempotency") || message.includes("refundable")) return Response.json({ error: "invalid_refund_request" }, { status: 409 });
    return Response.json({ error: "refund_unavailable" }, { status: 503 });
  }
}
