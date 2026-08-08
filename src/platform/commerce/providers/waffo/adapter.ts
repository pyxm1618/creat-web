import { WaffoPancake, WebhookEventType } from "@waffo/pancake-ts";

import { InvalidWebhookSignatureError, ProviderContractError } from "@/platform/commerce/application/errors";
import type {
  CreatedCheckout,
  CreateOneTimeCheckoutInput,
  PaymentProvider,
} from "@/platform/commerce/application/payment-provider";
import type { NormalizedPaymentSnapshot, NormalizedProviderEvent } from "@/platform/commerce/domain/events";
import { parseDisplayAmount } from "@/platform/commerce/domain/money";
import type { CommerceEnvironment } from "@/platform/commerce/domain/product";

export type WaffoProviderConfig = {
  readonly merchantId: string;
  readonly privateKey: string;
  readonly storeId?: string;
  readonly webhookPublicKey?: string | { readonly test?: string; readonly prod?: string };
  readonly baseUrl?: string;
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
  if (Number.isNaN(date.getTime())) throw new ProviderContractError("invalid Waffo event timestamp");
  return date;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderContractError(`missing Waffo field: ${field}`);
  }
  return value;
}

export function createWaffoPaymentProvider(config: WaffoProviderConfig): PaymentProvider {
  const client = new WaffoPancake({
    merchantId: config.merchantId,
    privateKey: config.privateKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.webhookPublicKey ? { webhookPublicKey: config.webhookPublicKey } : {}),
  });

  return {
    name: "waffo",

    async createOneTimeCheckout(input: CreateOneTimeCheckoutInput): Promise<CreatedCheckout> {
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
    },

    async getPayment(input): Promise<NormalizedPaymentSnapshot | null> {
      if (!input.merchantOrderReference && !input.externalPaymentId) {
        throw new ProviderContractError("payment lookup requires merchant order reference or payment id");
      }

      const filter = input.merchantOrderReference
        ? "orderMerchantExternalId: { eq: $reference }"
        : "id: { eq: $paymentId }";
      const variables = input.merchantOrderReference
        ? { reference: input.merchantOrderReference }
        : { paymentId: input.externalPaymentId };
      const variableDefinition = input.merchantOrderReference ? "$reference: String!" : "$paymentId: ID!";

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
      if (status !== "pending" && status !== "succeeded" && status !== "failed" && status !== "canceled") {
        throw new ProviderContractError(`unsupported Waffo payment status: ${status}`);
      }

      return {
        environment: "test",
        externalOrderId: payment.orderId,
        externalPaymentId: payment.id,
        ...(payment.orderMerchantExternalId
          ? { merchantOrderReference: payment.orderMerchantExternalId }
          : {}),
        status,
        occurredAt: new Date(),
      };
    },

    async verifyAndNormalizeWebhook({ rawBody, signature, environment }): Promise<NormalizedProviderEvent> {
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
      if (eventEnvironment !== environment) throw new ProviderContractError("Waffo webhook environment mismatch");
      if (config.storeId && event.storeId !== config.storeId) {
        throw new ProviderContractError("Waffo webhook store mismatch");
      }
      const occurredAt = eventDate(event.timestamp);
      const eventId = requireString(event.id, "id");

      if (event.eventType === WebhookEventType.OrderCompleted) {
        const externalOrderId = requireString(event.data.orderId, "data.orderId");
        const externalPaymentId = requireString(event.data.paymentId, "data.paymentId");
        const currency = requireString(event.data.currency, "data.currency");
        const amount = parseDisplayAmount(requireString(event.data.amount, "data.amount"), currency);
        return {
          type: "one_time_payment_succeeded",
          eventId,
          environment,
          externalOrderId,
          externalPaymentId,
          ...(event.data.orderMerchantExternalId
            ? { merchantOrderReference: event.data.orderMerchantExternalId }
            : {}),
          amount,
          occurredAt,
          storeId: event.storeId,
        };
      }

      if (event.eventType === WebhookEventType.RefundSucceeded) {
        const externalPaymentId = requireString(event.data.paymentId, "data.paymentId");
        const currency = requireString(event.data.currency, "data.currency");
        const amount = parseDisplayAmount(requireString(event.data.amount, "data.amount"), currency);
        return {
          type: "refund_succeeded",
          eventId,
          environment,
          externalPaymentId,
          ...(event.data.orderMerchantExternalId
            ? { merchantOrderReference: event.data.orderMerchantExternalId }
            : {}),
          amount,
          occurredAt,
        };
      }

      if (event.eventType === WebhookEventType.RefundFailed) {
        return {
          type: "refund_failed",
          eventId,
          environment,
          externalPaymentId: requireString(event.data.paymentId, "data.paymentId"),
          ...(event.data.orderMerchantExternalId
            ? { merchantOrderReference: event.data.orderMerchantExternalId }
            : {}),
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
