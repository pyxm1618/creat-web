import type { AccountSubjectStatus } from "@/platform/accounts/account-subject";

import type { NormalizedProviderEvent } from "../domain/events";

type SubscriptionEventType = Extract<
  NormalizedProviderEvent,
  { type: `subscription_${string}` }
>["type"];

const RESURRECTION_EVENTS = new Set<SubscriptionEventType>([
  "subscription_activated",
  "subscription_payment_succeeded",
  "subscription_uncanceled",
]);

export function subscriptionEventDisposition(
  subjectStatus: AccountSubjectStatus,
  eventType: SubscriptionEventType,
): "apply" | "reconcile" {
  return subjectStatus !== "active" && RESURRECTION_EVENTS.has(eventType) ? "reconcile" : "apply";
}

export async function guardSubscriptionEventForSubject<T>(input: {
  readonly subject: { readonly id: string; readonly status: AccountSubjectStatus };
  readonly eventType: SubscriptionEventType;
  readonly reconcile: () => Promise<void>;
  readonly apply: () => Promise<T>;
}): Promise<T | "reconciled"> {
  if (subscriptionEventDisposition(input.subject.status, input.eventType) === "reconcile") {
    await input.reconcile();
    return "reconciled";
  }
  return input.apply();
}
