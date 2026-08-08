import type { DatabaseClient } from "@/platform/database/client";
import { paymentWebhookInbox } from "@/platform/database/commerce-schema";

import { InvalidWebhookSignatureError } from "./errors";
import type { PaymentProvider } from "./payment-provider";
import { encryptWebhookPayload, payloadHash, retentionExpiry } from "./webhook-retention";
import type { NormalizedProviderEvent } from "../domain/events";
import type { CommerceEnvironment } from "../domain/product";

const MAX_WEBHOOK_BYTES = 256 * 1024;

type RetentionConfig = {
  readonly encryptionKeyBase64?: string;
  readonly keyId?: string;
};

function normalizedJson(event: NormalizedProviderEvent): Record<string, unknown> {
  switch (event.type) {
    case "one_time_payment_succeeded":
      return {
        type: event.type,
        eventId: event.eventId,
        environment: event.environment,
        externalOrderId: event.externalOrderId,
        ...(event.merchantOrderReference
          ? { merchantOrderReference: event.merchantOrderReference }
          : {}),
        externalPaymentId: event.externalPaymentId,
        amount: { currency: event.amount.currency, minor: event.amount.minor.toString() },
        occurredAt: event.occurredAt.toISOString(),
        ...(event.merchantId ? { merchantId: event.merchantId } : {}),
        ...(event.storeId ? { storeId: event.storeId } : {}),
      };
    case "refund_succeeded":
      return {
        type: event.type,
        eventId: event.eventId,
        environment: event.environment,
        externalPaymentId: event.externalPaymentId,
        ...(event.merchantOrderReference
          ? { merchantOrderReference: event.merchantOrderReference }
          : {}),
        amount: { currency: event.amount.currency, minor: event.amount.minor.toString() },
        occurredAt: event.occurredAt.toISOString(),
      };
    default:
      return {
        ...event,
        occurredAt: event.occurredAt.toISOString(),
      };
  }
}

export async function ingestProviderWebhook(input: {
  readonly database: DatabaseClient;
  readonly provider: PaymentProvider;
  readonly environment: CommerceEnvironment;
  readonly rawBody: Uint8Array;
  readonly signature: string;
  readonly retention: RetentionConfig;
  readonly now?: Date;
}): Promise<{
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly event?: NormalizedProviderEvent;
}> {
  const now = input.now ?? new Date();
  const size = input.rawBody.byteLength;
  if (size === 0 || size > MAX_WEBHOOK_BYTES) throw new Error("invalid webhook payload size");
  const hash = payloadHash(input.rawBody);

  let event: NormalizedProviderEvent;
  try {
    event = await input.provider.verifyAndNormalizeWebhook({
      rawBody: input.rawBody,
      signature: input.signature,
      environment: input.environment,
    });
  } catch (error) {
    if (!(error instanceof InvalidWebhookSignatureError)) throw error;
    const inserted = await input.database
      .insert(paymentWebhookInbox)
      .values({
        environment: input.environment,
        providerEventId: `invalid:${hash}`,
        dedupHash: hash,
        eventType: "invalid_signature",
        signatureValid: false,
        normalizedPayloadJson: {},
        payloadHash: hash,
        payloadSizeBytes: size,
        retentionClass: "invalid_signature",
        state: "rejected",
        processedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: paymentWebhookInbox.id });
    return { accepted: false, duplicate: inserted.length === 0 };
  }

  if (event.environment !== input.environment) throw new Error("webhook environment mismatch");

  const unsupported = event.type === "unsupported_signed_event";
  const retentionClass = unsupported ? "unresolved_encrypted" : "normalized_only";
  let rawPayloadCiphertext: Uint8Array | undefined;
  let rawPayloadExpiresAt: Date | undefined;
  if (unsupported) {
    if (!input.retention.encryptionKeyBase64 || !input.retention.keyId) {
      throw new Error("encrypted webhook retention key is required for unsupported signed events");
    }
    rawPayloadCiphertext = encryptWebhookPayload(
      input.rawBody,
      input.retention.encryptionKeyBase64,
    );
    rawPayloadExpiresAt = retentionExpiry("unresolved_encrypted", now);
  }

  const inserted = await input.database
    .insert(paymentWebhookInbox)
    .values({
      environment: input.environment,
      providerEventId: event.eventId,
      dedupHash: hash,
      eventType: event.type,
      signatureValid: true,
      normalizedPayloadJson: normalizedJson(event),
      payloadHash: hash,
      payloadSizeBytes: size,
      ...(rawPayloadCiphertext ? { rawPayloadCiphertext } : {}),
      ...(input.retention.keyId && rawPayloadCiphertext
        ? { rawPayloadKeyId: input.retention.keyId }
        : {}),
      ...(rawPayloadExpiresAt ? { rawPayloadExpiresAt } : {}),
      retentionClass,
      state: unsupported ? "unsupported" : "pending",
      nextAttemptAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: paymentWebhookInbox.id });

  return { accepted: true, duplicate: inserted.length === 0, event };
}
