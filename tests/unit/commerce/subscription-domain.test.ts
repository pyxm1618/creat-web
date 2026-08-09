import { describe, expect, it } from "vitest";

import {
  applySubscriptionTransition,
  type SubscriptionProjection,
} from "@/platform/commerce/domain/subscription";

const base: SubscriptionProjection = {
  status: "active",
  currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
  currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
  cancelAtPeriodEnd: false,
  pastDueStartedAt: null,
  pastDueGraceEndsAt: null,
  gracePolicyVersion: null,
};

describe("subscription projection", () => {
  it("freezes the first past-due grace deadline", () => {
    const first = applySubscriptionTransition(base, {
      type: "past_due",
      occurredAt: new Date("2026-08-10T00:00:00Z"),
      graceDays: 7,
      gracePolicyVersion: "v1",
    });
    const repeated = applySubscriptionTransition(first, {
      type: "past_due",
      occurredAt: new Date("2026-08-12T00:00:00Z"),
      graceDays: 30,
      gracePolicyVersion: "v2",
    });

    expect(first.pastDueGraceEndsAt?.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(repeated.pastDueStartedAt).toEqual(first.pastDueStartedAt);
    expect(repeated.pastDueGraceEndsAt).toEqual(first.pastDueGraceEndsAt);
    expect(repeated.gracePolicyVersion).toBe("v1");
  });

  it("renewal returns a past-due subscription to active and clears grace state", () => {
    const pastDue = applySubscriptionTransition(base, {
      type: "past_due",
      occurredAt: new Date("2026-08-10T00:00:00Z"),
      graceDays: 7,
      gracePolicyVersion: "v1",
    });
    const renewed = applySubscriptionTransition(pastDue, {
      type: "payment_succeeded",
      occurredAt: new Date("2026-08-15T00:00:00Z"),
      periodStart: new Date("2026-09-01T00:00:00Z"),
      periodEnd: new Date("2026-10-01T00:00:00Z"),
    });
    expect(renewed.status).toBe("active");
    expect(renewed.pastDueStartedAt).toBeNull();
    expect(renewed.pastDueGraceEndsAt).toBeNull();
  });

  it("supports canceling then resume without losing the active period", () => {
    const canceling = applySubscriptionTransition(base, {
      type: "canceling",
      occurredAt: new Date("2026-08-09T00:00:00Z"),
    });
    expect(canceling.status).toBe("canceling");
    expect(canceling.cancelAtPeriodEnd).toBe(true);

    const resumed = applySubscriptionTransition(canceling, {
      type: "uncanceled",
      occurredAt: new Date("2026-08-10T00:00:00Z"),
    });
    expect(resumed.status).toBe("active");
    expect(resumed.cancelAtPeriodEnd).toBe(false);
    expect(resumed.currentPeriodEnd).toEqual(base.currentPeriodEnd);
  });
});
