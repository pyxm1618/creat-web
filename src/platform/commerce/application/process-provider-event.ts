import type { DatabaseClient } from "@/platform/database/client";
import { commerceAppliedEvents } from "@/platform/database/commerce-event-schema";

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

export async function processProviderEvent(
  database: DatabaseClient,
  event: NormalizedProviderEvent,
  payloadHash: string,
): Promise<void> {
  if (event.type === "unsupported_signed_event") return;

  await database.transaction(async (tx) => {
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
    if (!application) return;

    if (
      event.type === "one_time_payment_succeeded" ||
      event.type === "one_time_payment_failed" ||
      event.type === "one_time_payment_canceled"
    ) {
      await processOneTimePaymentEvent(tx, event, payloadHash);
      return;
    }

    if (isSubscriptionEvent(event)) {
      await processSubscriptionEvent(tx, event, payloadHash);
      return;
    }

    await processRefundEvent(tx, event);
  });
}
