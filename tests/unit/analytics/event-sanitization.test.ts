import { describe, expect, it } from "vitest";

import { sanitizeAnalyticsEvent, type AnalyticsEventInput } from "@/platform/analytics/events";

describe("analytics event sanitization", () => {
  it("keeps only allowlisted event properties", () => {
    const input: AnalyticsEventInput = {
      name: "cta_click",
      properties: {
        cta: "start-reading",
        placement: "hero",
        email: "person@example.com",
        paymentCard: "4242424242424242",
        privateResult: "private generated content",
        authToken: "secret-token",
      },
    };

    expect(sanitizeAnalyticsEvent(input)).toEqual({
      name: "cta_click",
      properties: {
        cta: "start-reading",
        placement: "hero",
      },
    });
  });

  it("normalizes page views to a clean pathname without query or hash", () => {
    expect(
      sanitizeAnalyticsEvent({
        name: "page_view",
        properties: {
          path: "/pricing?email=person%40example.com#checkout",
          locale: "en",
        },
      }),
    ).toEqual({
      name: "page_view",
      properties: {
        path: "/pricing",
        locale: "en",
      },
    });
  });

  it("rejects unknown analytics event names", () => {
    expect(() =>
      sanitizeAnalyticsEvent({
        name: "arbitrary_private_payload" as never,
        properties: { value: "secret" },
      }),
    ).toThrow(/not allowlisted/i);
  });

  it("drops non-primitive, oversized, and email-like values even on allowlisted keys", () => {
    expect(
      sanitizeAnalyticsEvent({
        name: "feature_use",
        properties: {
          feature: "person@example.com",
          action: "x".repeat(300),
          outcome: { private: "value" } as never,
        },
      }),
    ).toEqual({ name: "feature_use", properties: {} });
  });
});
