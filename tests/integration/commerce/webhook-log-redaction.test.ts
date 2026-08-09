import { expect, it } from "vitest";

import { redactForLogging } from "@/platform/observability/redact";

it("redacts webhook secrets and private buyer data from structured logs", () => {
  const redacted = redactForLogging({
    event: "webhook_processing_failed",
    signature: "super-secret-signature",
    authorization: "Bearer secret-token",
    buyer: {
      email: "person@example.com",
      name: "Private Buyer",
      ip: "203.0.113.5",
    },
    payment: {
      paymentCard: "4242424242424242",
      token: "payment-secret-token",
    },
    normalized: {
      eventId: "evt_safe",
      orderId: "ord_safe",
      currency: "USD",
    },
  });

  const serialized = JSON.stringify(redacted);
  expect(serialized).not.toContain("super-secret-signature");
  expect(serialized).not.toContain("Bearer secret-token");
  expect(serialized).not.toContain("person@example.com");
  expect(serialized).not.toContain("Private Buyer");
  expect(serialized).not.toContain("203.0.113.5");
  expect(serialized).not.toContain("4242424242424242");
  expect(serialized).not.toContain("payment-secret-token");
  expect(serialized).toContain("evt_safe");
  expect(serialized).toContain("ord_safe");
});
