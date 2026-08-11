import type { AccountSubjectStatus } from "@/platform/accounts/account-subject";

import type { NormalizedProviderEvent } from "../domain/events";

type SubscriptionEventType = Extract<
  NormalizedProviderEvent,
  { type: `subscription_${string}` }
>["type"];

const DELETION_CONVERGENCE_EVENTS = new Set<SubscriptionEventType>([
  "subscription_canceling",
  "subscription_canceled",
]);

export function subscriptionEventDisposition(
  subjectStatus: AccountSubjectStatus,
  eventType: SubscriptionEventType,
): "apply" | "reconcile" {
  if (subjectStatus === "active") return "apply";
  return DELETION_CONVERGENCE_EVENTS.has(eventType) ? "apply" : "reconcile";
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
