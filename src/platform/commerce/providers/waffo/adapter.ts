import { WaffoPancake } from "@waffo/pancake-ts";

import {
  InvalidWebhookSignatureError,
  ProviderContractError,
} from "@/platform/commerce/application/errors";
import type {
  CreatedCheckout,
  CreateCheckoutInput,
  CreateOneTimeCheckoutInput,
  PaymentProvider,
  ProviderSubscriptionSnapshot,
  RefundRequest,
} from "@/platform/commerce/application/payment-provider";
import type {
  NormalizedPaymentSnapshot,
  NormalizedProviderEvent,
  NormalizedSubscriptionEvent,
} from "@/platform/commerce/domain/events";
import { formatDisplayAmount, parseDisplayAmount } from "@/platform/commerce/domain/money";
import type { CommerceEnvironment } from "@/platform/commerce/domain/product";

export type WaffoProviderConfig = {
  readonly merchantId: string;
  readonly privateKey: string;
  readonly storeId?: string;
  readonly webhookPublicKey?: string | { readonly test?: string; readonly prod?: string };
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
};

type PaymentQueryResult = {
  payments: Array<{
    id: string;
    orderId: string;
    status: string;
    orderMerchantExternalId?: string | null;
  }>;
};

function providerEnvironment(environment: CommerceEnvironment): "test" | "prod" {
  return environment === "production" ? "prod" : "test";
}

function localEnvironment(mode: string): CommerceEnvironment {
  if (mode === "prod") return "production";
  if (mode === "test") return "test";
  throw new ProviderContractError(`unsupported Waffo environment: ${mode}`);
}

function eventDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new ProviderContractError("invalid Waffo event timestamp");
  return date;
}

function optionalDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return eventDate(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderContractError(`missing Waffo field: ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function subscriptionStatus(value: string): ProviderSubscriptionSnapshot["status"] {
  if (
    value === "pending" ||
    value === "active" ||
    value === "past_due" ||
    value === "canceling" ||
    value === "canceled" ||
    value === "expired" ||
    value === "closed"
  ) {
    return value;
  }
  throw new ProviderContractError(`unsupported Waffo subscription status: ${value}`);
}

export function createWaffoPaymentProvider(config: WaffoProviderConfig): PaymentProvider {
  const client = new WaffoPancake({
    merchantId: config.merchantId,
    privateKey: config.privateKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.webhookPublicKey ? { webhookPublicKey: config.webhookPublicKey } : {}),
  });

  async function createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout> {
    const result = await client.checkout.authenticated.create({
      productId: input.providerProductId,
      currency: input.currency,
      buyerIdentity: input.buyerIdentity,
      ...(input.buyerEmail ? { buyerEmail: input.buyerEmail } : {}),
      successUrl: input.successUrl,
      orderMerchantExternalId: input.localOrderId,
    });
    return {
      externalCheckoutSessionId: result.sessionId,
      checkoutUrl: result.checkoutUrl,
    };
  }

  async function customerSession(buyerIdentity: string) {
    if (!config.storeId)
      throw new ProviderContractError("Waffo customer operations require storeId");
    const session = await client.auth.issueSessionToken({
      storeId: config.storeId,
      buyerIdentity,
    });
    return client.customer(session.token);
  }

  return {
    name: "waffo",
    capabilities: { oneTime: true, subscriptions: true, partialRefunds: true },
    createCheckout,
    createOneTimeCheckout(input: CreateOneTimeCheckoutInput) {
      return createCheckout({ ...input, model: "one_time" });
    },
    async cancelSubscription(input) {
      const customer = await customerSession(input.buyerIdentity);
      const result = await customer.cancelSubscription({ orderId: input.externalOrderId });
      return { externalOrderId: result.orderId, status: subscriptionStatus(result.status) };
    },
    async resumeSubscription(input) {
      const customer = await customerSession(input.buyerIdentity);
      const result = await customer.reactivateSubscription({ orderId: input.externalOrderId });
      return { externalOrderId: result.orderId, status: subscriptionStatus(result.status) };
    },
    async requestRefund(input: RefundRequest) {
      const customer = await customerSession(input.buyerIdentity);
      const result = await customer.createRefundTicket({
        paymentId: input.externalPaymentId,
        reason: input.reason,
        requestedAmount: {
          amount: formatDisplayAmount(input.amount),
          currency: input.amount.currency,
        },
        refundTicketMerchantExternalId: input.idempotencyKey,
      });
      const ticket = result.ticket;
      const status = String(ticket.status);
      if (status === "succeeded") {
        return { externalRefundReference: ticket.id, status: "succeeded" as const };
      }
      if (status === "failed" || status === "rejected" || status === "cancelled") {
        return { externalRefundReference: ticket.id, status: "failed" as const };
      }
      return {
        externalRefundReference: ticket.id,
        status: status === "processing" ? ("processing" as const) : ("pending" as const),
      };
    },
    async getPayment(input): Promise<NormalizedPaymentSnapshot | null> {
      if (!input.merchantOrderReference && !input.externalPaymentId) {
        throw new ProviderContractError(
          "payment lookup requires merchant order reference or payment id",
        );
      }
      const filter = input.merchantOrderReference
        ? "orderMerchantExternalId: { eq: $reference }"
        : "id: { eq: $paymentId }";
      const variables = input.merchantOrderReference
        ? { reference: input.merchantOrderReference }
        : { paymentId: input.externalPaymentId };
      const variableDefinition = input.merchantOrderReference
        ? "$reference: String!"
        : "$paymentId: ID!";
      const response = await client.graphql.query<PaymentQueryResult>({
        query: `query (${variableDefinition}) {
          payments(filter: { ${filter} }) {
            id
            orderId
            status
            orderMerchantExternalId
          }
        }`,
        variables,
      });
      if (response.errors?.length) {
        throw new ProviderContractError(response.errors.map((error) => error.message).join("; "));
      }
      const payment = response.data?.payments[0];
      if (!payment) return null;
      const status = payment.status;
      if (
        status !== "pending" &&
        status !== "succeeded" &&
        status !== "failed" &&
        status !== "canceled"
      ) {
        throw new ProviderContractError(`unsupported Waffo payment status: ${status}`);
      }
      return {
        environment: input.environment,
        externalOrderId: payment.orderId,
        externalPaymentId: payment.id,
        ...(payment.orderMerchantExternalId
          ? { merchantOrderReference: payment.orderMerchantExternalId }
          : {}),
        status,
        occurredAt: new Date(),
      };
    },
    async verifyAndNormalizeWebhook({
      rawBody,
      signature,
      environment,
    }): Promise<NormalizedProviderEvent> {
      const raw = new TextDecoder().decode(rawBody);
      let event;
      try {
        event = client.webhooks.verify(raw, signature, {
          environment: providerEnvironment(environment),
        });
      } catch {
        throw new InvalidWebhookSignatureError();
      }
      const eventEnvironment = localEnvironment(event.mode);
      if (eventEnvironment !== environment)
        throw new ProviderContractError("Waffo webhook environment mismatch");
      if (config.storeId && event.storeId !== config.storeId)
        throw new ProviderContractError("Waffo webhook store mismatch");
      const occurredAt = eventDate(event.timestamp);
      const eventId = requireString(event.id, "id");
      const merchantOrderReference = optionalString(event.data.orderMerchantExternalId);

      if (event.eventType === "order.completed") {
        const externalOrderId = requireString(event.data.orderId, "data.orderId");
        const externalPaymentId = requireString(event.data.paymentId, "data.paymentId");
        const currency = requireString(event.data.currency, "data.currency");
        const amount = parseDisplayAmount(
          requireString(event.data.amount, "data.amount"),
          currency,
        );
        return {
          type: "one_time_payment_succeeded",
          eventId,
          environment,
          externalOrderId,
          externalPaymentId,
          ...(merchantOrderReference ? { merchantOrderReference } : {}),
          amount,
          occurredAt,
          storeId: event.storeId,
        };
      }

      const subscriptionType = {
        "subscription.activated": "subscription_activated",
        "subscription.payment_succeeded": "subscription_payment_succeeded",
        "subscription.canceling": "subscription_canceling",
        "subscription.uncanceled": "subscription_uncanceled",
        "subscription.updated": "subscription_updated",
        "subscription.canceled": "subscription_canceled",
        "subscription.past_due": "subscription_past_due",
      }[event.eventType as string] as NormalizedSubscriptionEvent["type"] | undefined;
      if (subscriptionType) {
        const currency = optionalString(event.data.currency);
        const displayAmount = optionalString(event.data.amount);
        const externalPaymentId = optionalString(event.data.paymentId);
        const currentPeriodStart = optionalDate(event.data.currentPeriodStart);
        const currentPeriodEnd = optionalDate(event.data.currentPeriodEnd);
        const normalized: NormalizedSubscriptionEvent = {
          type: subscriptionType,
          eventId,
          environment,
          externalOrderId: requireString(event.data.orderId, "data.orderId"),
          ...(merchantOrderReference ? { merchantOrderReference } : {}),
          ...(externalPaymentId ? { externalPaymentId } : {}),
          ...(currency && displayAmount
            ? { amount: parseDisplayAmount(displayAmount, currency) }
            : {}),
          ...(currentPeriodStart ? { currentPeriodStart } : {}),
          ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
          occurredAt,
          storeId: event.storeId,
        };
        return normalized;
      }

      if (event.eventType === "refund.succeeded") {
        const externalPaymentId = requireString(event.data.paymentId, "data.paymentId");
        const currency = requireString(event.data.currency, "data.currency");
        const amount = parseDisplayAmount(
          requireString(event.data.amount, "data.amount"),
          currency,
        );
        const externalRefundReference = optionalString(event.data.refundId);
        return {
          type: "refund_succeeded",
          eventId,
          environment,
          externalPaymentId,
          ...(externalRefundReference ? { externalRefundReference } : {}),
          ...(merchantOrderReference ? { merchantOrderReference } : {}),
          amount,
          occurredAt,
        };
      }
      if (event.eventType === "refund.failed") {
        const externalRefundReference = optionalString(event.data.refundId);
        return {
          type: "refund_failed",
          eventId,
          environment,
          externalPaymentId: requireString(event.data.paymentId, "data.paymentId"),
          ...(externalRefundReference ? { externalRefundReference } : {}),
          ...(merchantOrderReference ? { merchantOrderReference } : {}),
          occurredAt,
        };
      }
      return {
        type: "unsupported_signed_event",
        eventId,
        environment,
        providerType: event.eventType,
        occurredAt,
      };
    },
  };
}
