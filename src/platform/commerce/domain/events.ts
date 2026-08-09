import type { CommerceEnvironment } from "./product";
import type { Money } from "./money";

export type NormalizedSubscriptionEvent = {
  readonly eventId: string;
  readonly environment: CommerceEnvironment;
  readonly externalOrderId: string;
  readonly merchantOrderReference?: string;
  readonly occurredAt: Date;
  readonly currentPeriodStart?: Date;
  readonly currentPeriodEnd?: Date;
  readonly externalPaymentId?: string;
  readonly amount?: Money;
  readonly merchantId?: string;
  readonly storeId?: string;
} & (
  | { readonly type: "subscription_activated" }
  | { readonly type: "subscription_payment_succeeded" }
  | { readonly type: "subscription_canceling" }
  | { readonly type: "subscription_uncanceled" }
  | { readonly type: "subscription_updated" }
  | { readonly type: "subscription_canceled" }
  | { readonly type: "subscription_past_due" }
);

export type NormalizedProviderEvent =
  | {
      readonly type: "one_time_payment_succeeded";
      readonly eventId: string;
      readonly environment: CommerceEnvironment;
      readonly externalOrderId: string;
      readonly merchantOrderReference?: string;
      readonly externalPaymentId: string;
      readonly amount: Money;
      readonly occurredAt: Date;
      readonly merchantId?: string;
      readonly storeId?: string;
    }
  | {
      readonly type: "one_time_payment_failed";
      readonly eventId: string;
      readonly environment: CommerceEnvironment;
      readonly externalOrderId: string;
      readonly merchantOrderReference?: string;
      readonly externalPaymentId?: string;
      readonly occurredAt: Date;
      readonly merchantId?: string;
      readonly storeId?: string;
    }
  | {
      readonly type: "one_time_payment_canceled";
      readonly eventId: string;
      readonly environment: CommerceEnvironment;
      readonly externalOrderId: string;
      readonly merchantOrderReference?: string;
      readonly externalPaymentId?: string;
      readonly occurredAt: Date;
      readonly merchantId?: string;
      readonly storeId?: string;
    }
  | NormalizedSubscriptionEvent
  | {
      readonly type: "refund_succeeded";
      readonly eventId: string;
      readonly environment: CommerceEnvironment;
      readonly externalPaymentId: string;
      readonly externalRefundReference?: string;
      readonly merchantOrderReference?: string;
      readonly amount: Money;
      readonly occurredAt: Date;
    }
  | {
      readonly type: "refund_failed";
      readonly eventId: string;
      readonly environment: CommerceEnvironment;
      readonly externalPaymentId: string;
      readonly externalRefundReference?: string;
      readonly merchantOrderReference?: string;
      readonly occurredAt: Date;
    }
  | {
      readonly type: "unsupported_signed_event";
      readonly eventId: string;
      readonly environment: CommerceEnvironment;
      readonly providerType: string;
      readonly occurredAt: Date;
    };

export type NormalizedPaymentSnapshot = {
  readonly environment: CommerceEnvironment;
  readonly externalOrderId: string;
  readonly merchantOrderReference?: string;
  readonly externalPaymentId?: string;
  readonly status: "pending" | "succeeded" | "failed" | "canceled";
  readonly amount?: Money;
  readonly occurredAt: Date;
};
