import { describe, expect, it } from "vitest";

import {
  parseNormalizedProviderEvent,
  serializeNormalizedProviderEvent,
} from "@/platform/commerce/application/event-json";
import type { NormalizedProviderEvent } from "@/platform/commerce/domain/events";

const occurredAt = new Date("2026-08-10T01:02:03.000Z");
const periodStart = new Date("2026-08-01T00:00:00.000Z");
const periodEnd = new Date("2026-09-01T00:00:00.000Z");

const fixtures: readonly NormalizedProviderEvent[] = [
  {
    type: "one_time_payment_succeeded",
    eventId: "evt-one-time-succeeded",
    environment: "test",
    externalOrderId: "order-one-time",
    merchantOrderReference: "merchant-order-one-time",
    externalPaymentId: "payment-one-time",
    amount: { currency: "USD", minor: 2900n },
    occurredAt,
    merchantId: "merchant-one-time",
    storeId: "store-one-time",
  },
  {
    type: "one_time_payment_failed",
    eventId: "evt-one-time-failed",
    environment: "production",
    externalOrderId: "order-failed",
    merchantOrderReference: "merchant-order-failed",
    externalPaymentId: "payment-failed",
    occurredAt,
    merchantId: "merchant-failed",
    storeId: "store-failed",
  },
  {
    type: "one_time_payment_canceled",
    eventId: "evt-one-time-canceled",
    environment: "test",
    externalOrderId: "order-canceled",
    merchantOrderReference: "merchant-order-canceled",
    externalPaymentId: "payment-canceled",
    occurredAt,
    merchantId: "merchant-canceled",
    storeId: "store-canceled",
  },
  ...(
    [
      "subscription_activated",
      "subscription_payment_succeeded",
      "subscription_canceling",
      "subscription_uncanceled",
      "subscription_updated",
      "subscription_canceled",
      "subscription_past_due",
    ] as const
  ).map(
    (type): NormalizedProviderEvent => ({
      type,
      eventId: `evt-${type}`,
      environment: "test",
      externalOrderId: `order-${type}`,
      merchantOrderReference: `merchant-order-${type}`,
      occurredAt,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      externalPaymentId: `payment-${type}`,
      amount: { currency: "EUR", minor: 1234n },
      merchantId: `merchant-${type}`,
      storeId: `store-${type}`,
    }),
  ),
  {
    type: "refund_succeeded",
    eventId: "evt-refund-succeeded",
    environment: "test",
    externalPaymentId: "payment-refund-succeeded",
    externalRefundReference: "refund-succeeded",
    merchantOrderReference: "merchant-order-refund-succeeded",
    amount: { currency: "USD", minor: 700n },
    occurredAt,
  },
  {
    type: "refund_failed",
    eventId: "evt-refund-failed",
    environment: "production",
    externalPaymentId: "payment-refund-failed",
    externalRefundReference: "refund-failed",
    merchantOrderReference: "merchant-order-refund-failed",
    occurredAt,
  },
  {
    type: "unsupported_signed_event",
    eventId: "evt-unsupported",
    environment: "test",
    providerType: "future.event",
    occurredAt,
  },
];

describe("normalized provider event JSON codec", () => {
  it.each(fixtures)("round-trips $type without losing declared fields", (event) => {
    const encoded = serializeNormalizedProviderEvent(event);
    expect(encoded).toMatchObject({ version: 1, type: event.type });
    expect(() => JSON.stringify(encoded)).not.toThrow();
    expect(parseNormalizedProviderEvent(JSON.parse(JSON.stringify(encoded)))).toEqual(event);
  });

  it("rejects payloads from an unknown wire version", () => {
    expect(() =>
      parseNormalizedProviderEvent({
        version: 2,
        type: "unsupported_signed_event",
        eventId: "future-event",
        environment: "test",
        providerType: "future.event",
        occurredAt: occurredAt.toISOString(),
      }),
    ).toThrow();
  });

  it.each([
    {
      name: "payment",
      payload: {
        type: "one_time_payment_succeeded",
        eventId: "legacy-payment-event",
        environment: "test",
        externalOrderId: "legacy-order",
        merchantOrderReference: "legacy-merchant-order",
        externalPaymentId: "legacy-payment",
        amount: { currency: "USD", minor: "2900" },
        occurredAt: "2026-08-09T01:02:03.000Z",
        merchantId: "legacy-merchant",
        storeId: "legacy-store",
      },
      expected: {
        type: "one_time_payment_succeeded",
        eventId: "legacy-payment-event",
        environment: "test",
        externalOrderId: "legacy-order",
        merchantOrderReference: "legacy-merchant-order",
        externalPaymentId: "legacy-payment",
        amount: { currency: "USD", minor: 2900n },
        occurredAt: new Date("2026-08-09T01:02:03.000Z"),
        merchantId: "legacy-merchant",
        storeId: "legacy-store",
      },
    },
    {
      name: "refund",
      payload: {
        type: "refund_failed",
        eventId: "legacy-refund-event",
        environment: "production",
        externalPaymentId: "legacy-refund-payment",
        externalRefundReference: "legacy-refund-reference",
        merchantOrderReference: "legacy-refund-order",
        occurredAt: "2026-08-09T02:03:04.000Z",
      },
      expected: {
        type: "refund_failed",
        eventId: "legacy-refund-event",
        environment: "production",
        externalPaymentId: "legacy-refund-payment",
        externalRefundReference: "legacy-refund-reference",
        merchantOrderReference: "legacy-refund-order",
        occurredAt: new Date("2026-08-09T02:03:04.000Z"),
      },
    },
  ] as const)("decodes a persisted versionless V0 $name event", ({ payload, expected }) => {
    expect(parseNormalizedProviderEvent(payload)).toEqual(expected);
  });
});
