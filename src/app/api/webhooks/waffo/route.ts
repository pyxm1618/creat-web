import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { attemptFulfillmentForSource } from "@/platform/commerce/application/attempt-fulfillment";
import { ingestProviderWebhook } from "@/platform/commerce/application/ingest-provider-webhook";
import { processProviderEvent } from "@/platform/commerce/application/process-provider-event";
import { payloadHash } from "@/platform/commerce/application/webhook-retention";
import { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import { paymentWebhookInbox } from "@/platform/database/commerce-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const commerce = await getCommerceRuntime();
  if (!commerce) return new Response("Not Found", { status: 404 });

  const signature = request.headers.get("x-waffo-signature");
  if (!signature) return Response.json({ error: "missing_signature" }, { status: 400 });
  const rawBody = new Uint8Array(await request.arrayBuffer());

  const ingested = await ingestProviderWebhook({
    database: commerce.database,
    provider: commerce.provider,
    environment: commerce.environment,
    rawBody,
    signature,
    retention: commerce.retention,
  });
  if (!ingested.accepted) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }
  if (ingested.operatorReview) {
    return Response.json({ accepted: true, operatorReview: true }, { status: 202 });
  }
  if (ingested.duplicate) {
    return Response.json({ accepted: true, duplicate: true }, { status: 202 });
  }
  if (!ingested.event || ingested.event.type === "unsupported_signed_event") {
    return Response.json({ accepted: true, queued: true }, { status: 202 });
  }

  try {
    await processProviderEvent(commerce.database, ingested.event, payloadHash(rawBody));
    await commerce.database
      .update(paymentWebhookInbox)
      .set({ state: "completed", processedAt: new Date(), lastErrorCode: null })
      .where(
        and(
          eq(paymentWebhookInbox.environment, commerce.environment),
          eq(paymentWebhookInbox.providerEventId, ingested.event.eventId),
        ),
      );

    if (ingested.event.type === "one_time_payment_succeeded") {
      await attemptFulfillmentForSource({
        database: commerce.database,
        fulfillment: commerce.fulfillment,
        sourceType: "payment",
        sourceId: ingested.event.externalPaymentId,
        owner: `webhook:${randomUUID()}`,
      });
    }
  } catch {
    // The durable inbox remains pending; scheduled recovery will retry without losing the signed event.
  }

  return Response.json({ accepted: true }, { status: 202 });
}
