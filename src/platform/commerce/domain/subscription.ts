export type SubscriptionStatus =
  | "pending"
  | "active"
  | "past_due"
  | "canceling"
  | "canceled"
  | "expired"
  | "closed";

export type SubscriptionProjection = {
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pastDueStartedAt: Date | null;
  readonly pastDueGraceEndsAt: Date | null;
  readonly gracePolicyVersion: string | null;
};

export type SubscriptionTransition =
  | {
      readonly type: "activated";
      readonly occurredAt: Date;
      readonly periodStart: Date;
      readonly periodEnd: Date;
    }
  | {
      readonly type: "payment_succeeded";
      readonly occurredAt: Date;
      readonly periodStart: Date;
      readonly periodEnd: Date;
    }
  | { readonly type: "canceling"; readonly occurredAt: Date }
  | { readonly type: "uncanceled"; readonly occurredAt: Date }
  | { readonly type: "canceled"; readonly occurredAt: Date }
  | {
      readonly type: "past_due";
      readonly occurredAt: Date;
      readonly graceDays: number;
      readonly gracePolicyVersion: string;
    }
  | { readonly type: "expired"; readonly occurredAt: Date }
  | { readonly type: "closed"; readonly occurredAt: Date };

function addUtcDays(value: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 0)
    throw new Error("grace days must be a nonnegative integer");
  return new Date(value.getTime() + days * 86_400_000);
}

export function applySubscriptionTransition(
  current: SubscriptionProjection,
  transition: SubscriptionTransition,
): SubscriptionProjection {
  switch (transition.type) {
    case "activated":
    case "payment_succeeded":
      return {
        ...current,
        status: "active",
        currentPeriodStart: transition.periodStart,
        currentPeriodEnd: transition.periodEnd,
        cancelAtPeriodEnd: false,
        pastDueStartedAt: null,
        pastDueGraceEndsAt: null,
        gracePolicyVersion: null,
      };
    case "past_due":
      if (current.status === "past_due" && current.pastDueStartedAt && current.pastDueGraceEndsAt) {
        return current;
      }
      return {
        ...current,
        status: "past_due",
        pastDueStartedAt: transition.occurredAt,
        pastDueGraceEndsAt: addUtcDays(transition.occurredAt, transition.graceDays),
        gracePolicyVersion: transition.gracePolicyVersion,
      };
    case "canceling":
      return { ...current, status: "canceling", cancelAtPeriodEnd: true };
    case "uncanceled":
      if (current.status !== "canceling")
        throw new Error("only canceling subscriptions can be resumed");
      return { ...current, status: "active", cancelAtPeriodEnd: false };
    case "canceled":
      return { ...current, status: "canceled", cancelAtPeriodEnd: false };
    case "expired":
      return { ...current, status: "expired", cancelAtPeriodEnd: false };
    case "closed":
      return { ...current, status: "closed", cancelAtPeriodEnd: false };
  }
}
