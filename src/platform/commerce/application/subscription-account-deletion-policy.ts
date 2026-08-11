import type { AccountSubjectStatus } from "@/platform/accounts/account-subject";

import type { NormalizedProviderEvent } from "../domain/events";
import type { SubscriptionStatus } from "../domain/subscription";

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
  subscriptionStatus?: SubscriptionStatus,
): "apply" | "reconcile" {
  if (subjectStatus === "active") return "apply";
  if (!DELETION_CONVERGENCE_EVENTS.has(eventType)) return "reconcile";
  if (
    eventType === "subscription_canceling" &&
    subscriptionStatus !== undefined &&
    ["canceled", "expired", "closed"].includes(subscriptionStatus)
  ) {
    return "reconcile";
  }
  if (
    eventType === "subscription_canceled" &&
    subscriptionStatus !== undefined &&
    ["expired", "closed"].includes(subscriptionStatus)
  ) {
    return "reconcile";
  }
  return "apply";
}

export async function guardSubscriptionEventForSubject<T>(input: {
  readonly subject: { readonly id: string; readonly status: AccountSubjectStatus };
  readonly eventType: SubscriptionEventType;
  readonly subscriptionStatus?: SubscriptionStatus;
  readonly reconcile: () => Promise<void>;
  readonly apply: () => Promise<T>;
}): Promise<T | "reconciled"> {
  if (
    subscriptionEventDisposition(
      input.subject.status,
      input.eventType,
      input.subscriptionStatus,
    ) === "reconcile"
  ) {
    await input.reconcile();
    return "reconciled";
  }
  return input.apply();
}
