export class CheckoutRequiresOperatorReviewError extends Error {
  constructor() {
    super("checkout requires operator review");
    this.name = "CheckoutRequiresOperatorReviewError";
  }
}
