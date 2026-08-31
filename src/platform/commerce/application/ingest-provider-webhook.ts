import { sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
  commerceReconciliationRuns,
  paymentWebhookInbox,
} from "@/platform/database/commerce-schema";

import { InvalidWebhookSignatureError } from "./errors";
import { serializeNormalizedProviderEvent } from "./event-json";
import type { PaymentProvider } from "./payment-provider";
import { encryptWebhookPayload, payloadHash, retentionExpiry } from "./webhook-retention";
import type { NormalizedProviderEvent } from "../domain/events";
import type { CommerceEnvironment } from "../domain/product";

const MAX_WEBHOOK_BYTES = 256 * 1024;

type RetentionConfig = {
  readonly encryptionKeyBase64?: string;
  readonly keyId?: string;
};

function invalidDiagnosticId(environment: CommerceEnvironment, now: Date): string {
  return `invalid:${environment}:${now.toISOString().slice(0, 16)}`;
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
  readonly operatorReview?: boolean;
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
    const providerEventId = invalidDiagnosticId(input.environment, now);
    const diagnosticDedupHash = payloadHash(new TextEncoder().encode(providerEventId));
    const duplicate = await input.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${providerEventId}, 0))`);
      const [existing] = await tx
        .select({ id: paymentWebhookInbox.id })
        .from(paymentWebhookInbox)
        .where(
          sql`${paymentWebhookInbox.environment} = ${input.environment} and ${paymentWebhookInbox.providerEventId} = ${providerEventId}`,
        )
        .limit(1);
      if (existing) {
        await tx
          .update(paymentWebhookInbox)
          .set({
            normalizedPayloadJson: sql<Record<string, unknown>>`jsonb_build_object(
              'occurrenceCount',
              CASE
                WHEN jsonb_typeof(${paymentWebhookInbox.normalizedPayloadJson} -> 'occurrenceCount') = 'number'
                  THEN (${paymentWebhookInbox.normalizedPayloadJson} ->> 'occurrenceCount')::bigint + 1
                ELSE 2
              END
            )`,
          })
          .where(sql`${paymentWebhookInbox.id} = ${existing.id}`);
        return true;
      }

      await tx.insert(paymentWebhookInbox).values({
        environment: input.environment,
        providerEventId,
        dedupHash: diagnosticDedupHash,
        eventType: "invalid_signature",
        signatureValid: false,
        normalizedPayloadJson: { occurrenceCount: 1 },
        payloadHash: hash,
        payloadSizeBytes: size,
        retentionClass: "invalid_signature",
        state: "rejected",
        receivedAt: now,
        processedAt: now,
      });
      return false;
    });
    return { accepted: false, duplicate };
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

  const ingressOutcome = await input.database.transaction(async (tx) => {
    const identityLock = `provider-webhook:${input.environment}:${event.eventId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identityLock}, 0))`);
    const [inserted] = await tx
      .insert(paymentWebhookInbox)
      .values({
        environment: input.environment,
        providerEventId: event.eventId,
        dedupHash: hash,
        eventType: event.type,
        signatureValid: true,
        normalizedPayloadJson: serializeNormalizedProviderEvent(event),
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
    if (inserted) return "inserted" as const;

    const [existing] = await tx
      .select({
        eventType: paymentWebhookInbox.eventType,
        payloadHash: paymentWebhookInbox.payloadHash,
      })
      .from(paymentWebhookInbox)
      .where(
        sql`${paymentWebhookInbox.environment} = ${input.environment} and ${paymentWebhookInbox.providerEventId} = ${event.eventId}`,
      )
      .limit(1)
      .for("update");
    if (!existing) throw new Error("webhook dedup hash identity conflict");
    if (existing.eventType === event.type && existing.payloadHash === hash) {
      return "duplicate" as const;
    }

    await tx
      .insert(commerceReconciliationRuns)
      .values({
        dedupKey: `provider-event-identity:${input.environment}:${event.eventId}`,
        targetType: "provider_event_identity",
        targetId: event.eventId,
        actorType: "provider_webhook_ingress",
        beforeJson: {
          eventType: existing.eventType,
          payloadHash: existing.payloadHash,
        },
        afterJson: { eventType: event.type, payloadHash: hash },
        result: "operator_review_required",
        createdAt: now,
      })
      .onConflictDoNothing();
    return "operator_review" as const;
  });

  if (ingressOutcome === "operator_review") {
    return { accepted: true, duplicate: false, operatorReview: true };
  }
  return { accepted: true, duplicate: ingressOutcome === "duplicate", event };
}
