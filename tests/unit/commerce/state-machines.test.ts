import { expect, it } from "vitest";

import { transitionOrder } from "@/platform/commerce/domain/order";
import { projectPayment } from "@/platform/commerce/domain/payment";

it("allows idempotent payment success but rejects paid-to-canceled regression", () => {
  expect(transitionOrder("pending", "payment_succeeded")).toBe("paid");
  expect(transitionOrder("paid", "payment_succeeded")).toBe("paid");
  expect(() => transitionOrder("paid", "payment_canceled")).toThrow("invalid order transition");
});

it("projects refunds only from successful payments", () => {
  expect(projectPayment({ status: "succeeded", refundStatus: "none" }, "refund_full_succeeded")).toEqual({
    status: "succeeded",
    refundStatus: "refunded",
  });
  expect(() =>
    projectPayment({ status: "failed", refundStatus: "none" }, "refund_full_succeeded"),
  ).toThrow("invalid payment transition");
});
