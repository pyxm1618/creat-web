import { and, eq } from "drizzle-orm";

import type { DatabaseClient, DatabaseTransaction } from "@/platform/database/client";
import { commerceAppliedEvents } from "@/platform/database/commerce-event-schema";
import { commerceReconciliationRuns } from "@/platform/database/commerce-schema";

import type { NormalizedProviderEvent } from "../domain/events";
import { processOneTimePaymentEvent } from "./process-one-time-payment-event";
import { processRefundEvent } from "./process-refund-event";
import { processSubscriptionEvent } from "./process-subscription-event";

function isSubscriptionEvent(event: NormalizedProviderEvent): event is Extract<
  NormalizedProviderEvent,
  {
    type:
      | "subscription_activated"
      | "subscription_payment_succeeded"
      | "subscription_canceling"
      | "subscription_uncanceled"
      | "subscription_updated"
      | "subscription_canceled"
      | "subscription_past_due";
  }
> {
  return event.type.startsWith("subscription_");
}

export type ProcessProviderEventOutcome =
  | "applied"
  | "replay"
  | "identity_conflict"
  | "operator_review";

export async function processProviderEventInTransaction(
  tx: DatabaseTransaction,
  event: NormalizedProviderEvent,
  payloadHash: string,
): Promise<ProcessProviderEventOutcome> {
  if (event.type === "unsupported_signed_event") return "replay";

  const [application] = await tx
    .insert(commerceAppliedEvents)
    .values({
      environment: event.environment,
      providerEventId: event.eventId,
      eventType: event.type,
      payloadHash,
    })
    .onConflictDoNothing({
      target: [commerceAppliedEvents.environment, commerceAppliedEvents.providerEventId],
    })
    .returning({ id: commerceAppliedEvents.id });
  if (!application) {
    const [existing] = await tx
      .select({
        eventType: commerceAppliedEvents.eventType,
        payloadHash: commerceAppliedEvents.payloadHash,
      })
      .from(commerceAppliedEvents)
      .where(
        and(
          eq(commerceAppliedEvents.environment, event.environment),
          eq(commerceAppliedEvents.providerEventId, event.eventId),
        ),
      )
      .limit(1)
      .for("update");
    if (!existing) throw new Error("applied provider event identity disappeared");
    if (existing.eventType === event.type && existing.payloadHash === payloadHash) return "replay";

    await tx
      .insert(commerceReconciliationRuns)
      .values({
        dedupKey: `provider-event-identity:${event.environment}:${event.eventId}`,
        targetType: "provider_event_identity",
        targetId: event.eventId,
        actorType: "provider_event",
        beforeJson: {
          eventType: existing.eventType,
          payloadHash: existing.payloadHash,
        },
        afterJson: { eventType: event.type, payloadHash },
        result: "operator_review_required",
      })
      .onConflictDoNothing();
    return "identity_conflict";
  }

  if (
    event.type === "one_time_payment_succeeded" ||
    event.type === "one_time_payment_failed" ||
    event.type === "one_time_payment_canceled"
  ) {
    return processOneTimePaymentEvent(tx, event, payloadHash);
  }

  if (isSubscriptionEvent(event)) {
    await processSubscriptionEvent(tx, event, payloadHash);
    return "applied";
  }

  await processRefundEvent(tx, event);
  return "applied";
}

export async function processProviderEvent(
  database: DatabaseClient,
  event: NormalizedProviderEvent,
  payloadHash: string,
): Promise<void> {
  const outcome = await database.transaction(async (tx) => {
    return processProviderEventInTransaction(tx, event, payloadHash);
  });
  if (outcome === "identity_conflict") throw new Error("provider event identity conflict");
}
