import type { NormalizedPaymentSnapshot, NormalizedProviderEvent } from "../domain/events";
import type { Money } from "../domain/money";
import type { CommerceEnvironment } from "../domain/product";

export type PaymentProviderId = string;
export type PurchaseModel = "one_time" | "subscription";

export type CreateCheckoutInput = {
  readonly model: PurchaseModel;
  readonly localOrderId: string;
  readonly providerProductId: string;
  readonly expectedDisplayAmount: string;
  readonly currency: string;
  readonly buyerIdentity: string;
  readonly buyerEmail?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
};

export type CreateOneTimeCheckoutInput = Omit<CreateCheckoutInput, "model">;

export type CreatedCheckout = {
  readonly externalCheckoutSessionId: string;
  readonly externalOrderId?: string;
  readonly checkoutUrl: string;
};

export type ProviderSubscriptionSnapshot = {
  readonly externalOrderId: string;
  readonly status: "pending" | "active" | "past_due" | "canceling" | "canceled" | "expired" | "closed";
};

export type RefundRequest = {
  readonly environment: CommerceEnvironment;
  readonly buyerIdentity: string;
  readonly externalPaymentId: string;
  readonly amount: Money;
  readonly reason: string;
  readonly idempotencyKey: string;
};

export interface PaymentProvider {
  readonly name: PaymentProviderId;
  readonly capabilities: {
    readonly oneTime: boolean;
    readonly subscriptions: boolean;
    readonly partialRefunds: boolean;
  };
  createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout>;
  createOneTimeCheckout(input: CreateOneTimeCheckoutInput): Promise<CreatedCheckout>;
  cancelSubscription(input: {
    readonly environment: CommerceEnvironment;
    readonly buyerIdentity: string;
    readonly externalOrderId: string;
  }): Promise<ProviderSubscriptionSnapshot>;
  resumeSubscription(input: {
    readonly environment: CommerceEnvironment;
    readonly buyerIdentity: string;
    readonly externalOrderId: string;
  }): Promise<ProviderSubscriptionSnapshot>;
  requestRefund(input: RefundRequest): Promise<{
    readonly externalRefundReference: string;
    readonly status: "pending" | "processing" | "succeeded" | "failed";
  }>;
  getPayment(input: {
    readonly environment: CommerceEnvironment;
    readonly merchantOrderReference?: string;
    readonly externalOrderId?: string;
    readonly externalPaymentId?: string;
  }): Promise<NormalizedPaymentSnapshot | null>;
  verifyAndNormalizeWebhook(input: {
    readonly rawBody: Uint8Array;
    readonly signature: string;
    readonly environment: CommerceEnvironment;
  }): Promise<NormalizedProviderEvent>;
}
