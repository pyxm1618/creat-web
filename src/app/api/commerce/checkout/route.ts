import { z } from "zod";

import { CheckoutRequiresOperatorReviewError } from "@/platform/commerce/application/checkout-errors";
import { createCheckout } from "@/platform/commerce/application/create-checkout";
import { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import { getAccountContext } from "@/platform/auth/account-context";
import { env } from "@/platform/config/env";
import { featuresConfig } from "@/config/features.config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ productKey: z.string().trim().min(1).max(120) });

function conflict(error: unknown): boolean {
  return (
    error instanceof CheckoutRequiresOperatorReviewError ||
    (error instanceof Error &&
      (error.message === "checkout initialization in progress" ||
        error.message === "checkout already created"))
  );
}

export async function POST(request: Request): Promise<Response> {
  const commerce = await getCommerceRuntime();
  if (!commerce) return new Response("Not Found", { status: 404 });
  if (request.headers.get("origin") !== env.appOrigin)
    return Response.json({ error: "invalid_origin" }, { status: 403 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return Response.json({ error: "invalid_content_type" }, { status: 415 });

  const account = await getAccountContext(request.headers);
  if (!account) return Response.json({ error: "authentication_required" }, { status: 401 });
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });

  try {
    const product = commerce.catalog.getEnabled(parsed.data.productKey, commerce.environment);
    if (product.commercialModel === "one_time" && !featuresConfig.commerce.oneTime)
      return new Response("Not Found", { status: 404 });
    if (product.commercialModel === "subscription" && !featuresConfig.commerce.subscriptions)
      return new Response("Not Found", { status: 404 });
    const result = await createCheckout(
      {
        subjectId: account.subject.id,
        buyerIdentity: account.subject.id,
        buyerEmail: account.user.email,
        productKey: parsed.data.productKey,
        environment: commerce.environment,
        idempotencyKey,
        appOrigin: env.appOrigin,
      },
      commerce,
    );
    return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (conflict(error)) return Response.json({ error: "checkout_conflict" }, { status: 409 });
    if (
      error instanceof Error &&
      (error.message.includes("product") || error.message.includes("idempotency"))
    )
      return Response.json({ error: "invalid_checkout_request" }, { status: 400 });
    return Response.json({ error: "checkout_unavailable" }, { status: 502 });
  }
}
