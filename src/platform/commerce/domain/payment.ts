export type PaymentStatus = "pending" | "succeeded" | "failed" | "canceled";
export type RefundStatus = "none" | "partial" | "refunded" | "failed";

export type PaymentProjection = {
  readonly status: PaymentStatus;
  readonly refundStatus: RefundStatus;
};

export type PaymentEvent =
  | "payment_pending"
  | "payment_succeeded"
  | "payment_failed"
  | "payment_canceled"
  | "refund_partial_succeeded"
  | "refund_full_succeeded"
  | "refund_failed";

export function projectPayment(current: PaymentProjection, event: PaymentEvent): PaymentProjection {
  switch (event) {
    case "payment_pending":
      if (current.status === "pending") return current;
      break;
    case "payment_succeeded":
      if (current.status === "pending" || current.status === "succeeded") {
        return { ...current, status: "succeeded" };
      }
      break;
    case "payment_failed":
      if (current.status === "pending" || current.status === "failed") {
        return { ...current, status: "failed" };
      }
      break;
    case "payment_canceled":
      if (current.status === "pending" || current.status === "canceled") {
        return { ...current, status: "canceled" };
      }
      break;
    case "refund_partial_succeeded":
      if (current.status === "succeeded") return { ...current, refundStatus: "partial" };
      break;
    case "refund_full_succeeded":
      if (current.status === "succeeded") return { ...current, refundStatus: "refunded" };
      break;
    case "refund_failed":
      if (current.status === "succeeded") return { ...current, refundStatus: "failed" };
      break;
  }
  throw new Error(`invalid payment transition: ${current.status}/${current.refundStatus} -> ${event}`);
}
