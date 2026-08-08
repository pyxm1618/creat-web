export type OrderStatus = "pending" | "paid" | "canceled" | "partially_refunded" | "refunded";
export type OrderEvent =
  | "payment_pending"
  | "payment_succeeded"
  | "payment_canceled"
  | "refund_partial_succeeded"
  | "refund_full_succeeded";

export function transitionOrder(status: OrderStatus, event: OrderEvent): OrderStatus {
  if (event === "payment_succeeded") {
    if (status === "pending" || status === "paid") return "paid";
  }
  if (event === "payment_pending") {
    if (status === "pending") return "pending";
  }
  if (event === "payment_canceled") {
    if (status === "pending" || status === "canceled") return "canceled";
  }
  if (event === "refund_partial_succeeded") {
    if (status === "paid" || status === "partially_refunded") return "partially_refunded";
  }
  if (event === "refund_full_succeeded") {
    if (status === "paid" || status === "partially_refunded" || status === "refunded") {
      return "refunded";
    }
  }
  throw new Error(`invalid order transition: ${status} -> ${event}`);
}
