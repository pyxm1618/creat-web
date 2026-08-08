import type { NormalizedPaymentSnapshot, NormalizedProviderEvent } from "../domain/events";
import type { CommerceEnvironment } from "../domain/product";

export type CreateOneTimeCheckoutInput = {
  readonly localOrderId: string;
  readonly providerProductId: string;
  readonly expectedDisplayAmount: string;
  readonly currency: string;
  readonly buyerIdentity: string;
  readonly buyerEmail?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
};

export type CreatedCheckout = {
  readonly externalCheckoutSessionId: string;
  readonly externalOrderId?: string;
  readonly checkoutUrl: string;
};

export interface PaymentProvider {
  readonly name: "waffo";
  createOneTimeCheckout(input: CreateOneTimeCheckoutInput): Promise<CreatedCheckout>;
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
