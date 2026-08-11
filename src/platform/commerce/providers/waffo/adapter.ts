import { WaffoPancake } from "@waffo/pancake-ts";

import {
  InvalidWebhookSignatureError,
  ProviderContractError,
} from "@/platform/commerce/application/errors";
import type {
  CreatedCheckout,
  CreateCheckoutInput,
  CreateOneTimeCheckoutInput,
  PaymentLookupResult,
  PaymentProvider,
  ProviderQueryWarning,
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

const PAYMENT_QUERY_LIMIT = 100;
const DEFAULT_PAYMENT_QUERY_TIMEOUT_MS = 5_000;

type PaymentQueryResult = {
  readonly payments?: unknown;
  readonly paymentsCount?: unknown;
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

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderContractError(`invalid Waffo field: ${field}`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProviderContractError(`invalid Waffo field: ${field}`);
  }
  return value;
}

function paymentDate(value: unknown): Date {
  const raw = requireString(value, "payment.createdAt");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw)) {
    throw new ProviderContractError("invalid Waffo payment timestamp");
  }
  const date = new Date(raw);
  const normalized = raw.includes(".") ? raw : raw.replace(/Z$/, ".000Z");
  if (Number.isNaN(date.getTime()) || date.toISOString() !== normalized) {
    throw new ProviderContractError("invalid Waffo payment timestamp");
  }
  return date;
}

function paymentStatus(value: unknown): "pending" | "succeeded" | "failed" | "canceled" {
  if (value === "pending" || value === "succeeded" || value === "failed" || value === "canceled") {
    return value;
  }
  throw new ProviderContractError(`unsupported Waffo payment status: ${String(value)}`);
}

function paymentAmount(value: unknown) {
  const amount = requireRecord(value, "payment.snapshotAmountDetails");
  const currency = requireString(amount.currency, "payment.snapshotAmountDetails.currency");
  const total = requireString(amount.total, "payment.snapshotAmountDetails.total");
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ProviderContractError("invalid Waffo payment currency");
  }
  try {
    return parseDisplayAmount(total, currency);
  } catch {
    throw new ProviderContractError("invalid Waffo payment amount");
  }
}

function queryWarnings(value: unknown): readonly ProviderQueryWarning[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ProviderContractError("invalid Waffo query warnings");
  return value.map((entry, index) => {
    const warning = requireRecord(entry, `warnings[${index}]`);
    const message = requireString(warning.message, `warnings[${index}].message`);
    const layer = requireString(warning.layer, `warnings[${index}].layer`);
    const aiHint = optionalString(warning.aiHint);
    return { message, layer, ...(aiHint ? { aiHint } : {}) };
  });
}

function scopedRequestSignal(input: {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  const timeoutMs = input.timeoutMs ?? DEFAULT_PAYMENT_QUERY_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new ProviderContractError("invalid Waffo payment lookup timeout");
  }
  const controller = new AbortController();
  const abortFromCaller = () => {
    controller.abort(input.signal?.reason ?? new DOMException("aborted", "AbortError"));
  };
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("Waffo payment lookup timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortFromCaller);
    },
  };
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

function normalizedPayment(
  value: unknown,
  input: Parameters<PaymentProvider["getPayment"]>[0],
  expectedStoreId: string,
): NormalizedPaymentSnapshot {
  const payment = requireRecord(value, "payment");
  const externalPaymentId = requireString(payment.id, "payment.id");
  const externalOrderId = requireString(payment.orderId, "payment.orderId");
  const merchantOrderReference = requireString(
    payment.orderMerchantExternalId,
    "payment.orderMerchantExternalId",
  );
  if (input.externalPaymentId && externalPaymentId !== input.externalPaymentId) {
    throw new ProviderContractError("Waffo payment id mismatch");
  }
  if (input.merchantOrderReference && merchantOrderReference !== input.merchantOrderReference) {
    throw new ProviderContractError("Waffo merchant order reference mismatch");
  }
  if (input.externalOrderId && externalOrderId !== input.externalOrderId) {
    throw new ProviderContractError("Waffo order id mismatch");
  }

  const onetimeOrder =
    payment.onetimeOrder === null || payment.onetimeOrder === undefined
      ? undefined
      : requireRecord(payment.onetimeOrder, "payment.onetimeOrder");
  const subscriptionOrder =
    payment.subscriptionOrder === null || payment.subscriptionOrder === undefined
      ? undefined
      : requireRecord(payment.subscriptionOrder, "payment.subscriptionOrder");
  if (Boolean(onetimeOrder) === Boolean(subscriptionOrder)) {
    throw new ProviderContractError("Waffo payment must have exactly one order relation");
  }
  const relation = onetimeOrder ?? subscriptionOrder;
  if (!relation) throw new ProviderContractError("Waffo payment order relation missing");
  if (requireString(relation.id, "payment.order.id") !== externalOrderId) {
    throw new ProviderContractError("Waffo payment relation order id mismatch");
  }
  const store = requireRecord(relation.store, "payment.order.store");
  const storeId = requireString(store.id, "payment.order.store.id");
  if (storeId !== expectedStoreId) throw new ProviderContractError("Waffo payment store mismatch");

  const model = onetimeOrder ? "one_time" : "subscription";
  if (onetimeOrder) {
    const testMode = requireBoolean(onetimeOrder.testMode, "payment.onetimeOrder.testMode");
    if (testMode !== (input.environment === "test")) {
      throw new ProviderContractError("Waffo one-time payment environment mismatch");
    }
  }

  return {
    environment: input.environment,
    model,
    storeId,
    externalOrderId,
    merchantOrderReference,
    externalPaymentId,
    status: paymentStatus(payment.status),
    amount: paymentAmount(payment.snapshotAmountDetails),
    occurredAt: paymentDate(payment.createdAt),
  };
}

export function createWaffoPaymentProvider(config: WaffoProviderConfig): PaymentProvider {
  const baseFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  const createClient = (requestFetch?: typeof fetch) =>
    new WaffoPancake({
      merchantId: config.merchantId,
      privateKey: config.privateKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(requestFetch ? { fetch: requestFetch } : {}),
      ...(config.webhookPublicKey ? { webhookPublicKey: config.webhookPublicKey } : {}),
    });
  const client = createClient(config.fetch);

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
    async getPayment(input): Promise<PaymentLookupResult> {
      if (
        (input.merchantOrderReference !== undefined &&
          input.merchantOrderReference.trim().length === 0) ||
        (input.externalPaymentId !== undefined && input.externalPaymentId.trim().length === 0) ||
        (input.externalOrderId !== undefined && input.externalOrderId.trim().length === 0)
      ) {
        throw new ProviderContractError(
          "payment lookup identities and cross-checks must be non-empty",
        );
      }
      if (!input.merchantOrderReference && !input.externalPaymentId) {
        throw new ProviderContractError(
          "payment lookup requires merchant order reference or payment id",
        );
      }
      const expectedStoreId = config.storeId;
      if (!expectedStoreId) {
        throw new ProviderContractError("Waffo payment lookup requires storeId");
      }
      const definitions = [];
      const filters = [];
      const variables: Record<string, unknown> = {};
      if (input.merchantOrderReference) {
        definitions.push("$reference: String!");
        filters.push("orderMerchantExternalId: { eq: $reference }");
        variables.reference = input.merchantOrderReference;
      }
      if (input.externalPaymentId) {
        definitions.push("$paymentId: String!");
        filters.push("id: { eq: $paymentId }");
        variables.paymentId = input.externalPaymentId;
      }
      const filter = `{ ${filters.join(", ")} }`;
      const request = scopedRequestSignal(input);
      const scopedClient = createClient((requestInfo, init) =>
        baseFetch(requestInfo, { ...init, signal: request.signal }),
      );
      try {
        const response = await scopedClient.graphql.query<PaymentQueryResult>({
          query: `query (${definitions.join(", ")}) {
          payments(limit: ${PAYMENT_QUERY_LIMIT}, filter: ${filter}) {
            id
            orderId
            status
            orderMerchantExternalId
            snapshotAmountDetails { currency total }
            onetimeOrder { id testMode store { id } }
            subscriptionOrder { id store { id } }
            createdAt
          }
          paymentsCount(filter: ${filter})
        }`,
          variables,
        });
        if (request.signal.aborted) {
          throw request.signal.reason ?? new DOMException("aborted", "AbortError");
        }
        if (response.errors?.length) {
          throw new ProviderContractError(response.errors.map((error) => error.message).join("; "));
        }
        const data = requireRecord(response.data, "payment query data");
        if (!Array.isArray(data.payments)) {
          throw new ProviderContractError("invalid Waffo payments result");
        }
        if (!Number.isInteger(data.paymentsCount) || Number(data.paymentsCount) < 0) {
          throw new ProviderContractError("invalid Waffo payments count");
        }
        const count = Number(data.paymentsCount);
        if (count > PAYMENT_QUERY_LIMIT) {
          throw new ProviderContractError("Waffo payment query exceeded bounded limit");
        }
        if (count !== data.payments.length) {
          throw new ProviderContractError("Waffo payment query count mismatch");
        }
        const payments = data.payments.map((payment) =>
          normalizedPayment(payment, input, expectedStoreId),
        );
        if (
          new Set(payments.map((payment) => payment.externalPaymentId)).size !== payments.length
        ) {
          throw new ProviderContractError("Waffo payment query returned duplicate ids");
        }
        return {
          payments,
          warnings: queryWarnings(response.warnings),
        };
      } finally {
        request.cleanup();
      }
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
