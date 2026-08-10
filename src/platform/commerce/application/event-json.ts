import { z } from "zod";

import type { NormalizedProviderEvent } from "../domain/events";
import { currencyExponent, type SupportedCurrency } from "../domain/money";
import type { CommerceEnvironment } from "../domain/product";

type EventJsonV1 = {
  readonly version: 1;
  readonly type: NormalizedProviderEvent["type"];
  readonly eventId: string;
  readonly environment: CommerceEnvironment;
  readonly occurredAt: string;
  readonly amount?: { readonly currency: string; readonly minor: string };
} & Record<string, unknown>;

const amountSchema = z.object({
  currency: z.string().length(3),
  minor: z.string().regex(/^\d+$/),
});
const baseFields = {
  type: z.string(),
  eventId: z.string().min(1),
  environment: z.enum(["test", "production"]),
  occurredAt: z.iso.datetime(),
} as const;
const legacyV0Base = z.object(baseFields);
const v1Base = z.object({ version: z.literal(1), ...baseFields });
const providerIdentityFields = {
  merchantId: z.string().min(1).optional(),
  storeId: z.string().min(1).optional(),
};
const orderFields = {
  externalOrderId: z.string().min(1),
  merchantOrderReference: z.string().min(1).optional(),
};

function supportedCurrency(value: string): SupportedCurrency {
  currencyExponent(value);
  return value.toUpperCase() as SupportedCurrency;
}

function assertNever(value: never): never {
  throw new Error(`unsupported normalized provider event: ${JSON.stringify(value)}`);
}

function commonJson(event: NormalizedProviderEvent): EventJsonV1 {
  return {
    version: 1,
    type: event.type,
    eventId: event.eventId,
    environment: event.environment,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function optionalOrderReference(event: {
  readonly merchantOrderReference?: string | undefined;
}): Record<string, string> {
  return event.merchantOrderReference
    ? { merchantOrderReference: event.merchantOrderReference }
    : {};
}

function optionalProviderIdentity(event: {
  readonly merchantId?: string | undefined;
  readonly storeId?: string | undefined;
}): Record<string, string> {
  return {
    ...(event.merchantId ? { merchantId: event.merchantId } : {}),
    ...(event.storeId ? { storeId: event.storeId } : {}),
  };
}

function amountJson(amount: { readonly currency: string; readonly minor: bigint }) {
  return { currency: amount.currency, minor: amount.minor.toString() };
}

export function serializeNormalizedProviderEvent(
  event: NormalizedProviderEvent,
): Record<string, unknown> {
  const common = commonJson(event);
  switch (event.type) {
    case "one_time_payment_succeeded":
      return {
        ...common,
        externalOrderId: event.externalOrderId,
        ...optionalOrderReference(event),
        externalPaymentId: event.externalPaymentId,
        amount: amountJson(event.amount),
        ...optionalProviderIdentity(event),
      };
    case "one_time_payment_failed":
    case "one_time_payment_canceled":
      return {
        ...common,
        externalOrderId: event.externalOrderId,
        ...optionalOrderReference(event),
        ...(event.externalPaymentId ? { externalPaymentId: event.externalPaymentId } : {}),
        ...optionalProviderIdentity(event),
      };
    case "subscription_activated":
    case "subscription_payment_succeeded":
    case "subscription_canceling":
    case "subscription_uncanceled":
    case "subscription_updated":
    case "subscription_canceled":
    case "subscription_past_due":
      return {
        ...common,
        externalOrderId: event.externalOrderId,
        ...optionalOrderReference(event),
        ...(event.currentPeriodStart
          ? { currentPeriodStart: event.currentPeriodStart.toISOString() }
          : {}),
        ...(event.currentPeriodEnd
          ? { currentPeriodEnd: event.currentPeriodEnd.toISOString() }
          : {}),
        ...(event.externalPaymentId ? { externalPaymentId: event.externalPaymentId } : {}),
        ...(event.amount ? { amount: amountJson(event.amount) } : {}),
        ...optionalProviderIdentity(event),
      };
    case "refund_succeeded":
      return {
        ...common,
        externalPaymentId: event.externalPaymentId,
        ...(event.externalRefundReference
          ? { externalRefundReference: event.externalRefundReference }
          : {}),
        ...optionalOrderReference(event),
        amount: amountJson(event.amount),
      };
    case "refund_failed":
      return {
        ...common,
        externalPaymentId: event.externalPaymentId,
        ...(event.externalRefundReference
          ? { externalRefundReference: event.externalRefundReference }
          : {}),
        ...optionalOrderReference(event),
      };
    case "unsupported_signed_event":
      return { ...common, providerType: event.providerType };
    default:
      return assertNever(event);
  }
}

function parsedAmount(value: z.infer<typeof amountSchema>) {
  return {
    currency: supportedCurrency(value.currency),
    minor: BigInt(value.minor),
  };
}

function parseV1NormalizedProviderEvent(value: unknown): NormalizedProviderEvent {
  const parsedBase = v1Base.parse(value);
  const environment = parsedBase.environment as CommerceEnvironment;
  const occurredAt = new Date(parsedBase.occurredAt);

  switch (parsedBase.type) {
    case "one_time_payment_succeeded": {
      const parsed = v1Base
        .extend({
          ...orderFields,
          externalPaymentId: z.string().min(1),
          amount: amountSchema,
          ...providerIdentityFields,
        })
        .parse(value);
      return {
        type: "one_time_payment_succeeded",
        eventId: parsed.eventId,
        environment,
        externalOrderId: parsed.externalOrderId,
        ...optionalOrderReference(parsed),
        externalPaymentId: parsed.externalPaymentId,
        amount: parsedAmount(parsed.amount),
        occurredAt,
        ...optionalProviderIdentity(parsed),
      };
    }
    case "one_time_payment_failed":
    case "one_time_payment_canceled": {
      const parsed = v1Base
        .extend({
          ...orderFields,
          externalPaymentId: z.string().min(1).optional(),
          ...providerIdentityFields,
        })
        .parse(value);
      return {
        type: parsedBase.type,
        eventId: parsed.eventId,
        environment,
        externalOrderId: parsed.externalOrderId,
        ...optionalOrderReference(parsed),
        ...(parsed.externalPaymentId ? { externalPaymentId: parsed.externalPaymentId } : {}),
        occurredAt,
        ...optionalProviderIdentity(parsed),
      };
    }
    case "subscription_activated":
    case "subscription_payment_succeeded":
    case "subscription_canceling":
    case "subscription_uncanceled":
    case "subscription_updated":
    case "subscription_canceled":
    case "subscription_past_due": {
      const parsed = v1Base
        .extend({
          ...orderFields,
          currentPeriodStart: z.iso.datetime().optional(),
          currentPeriodEnd: z.iso.datetime().optional(),
          externalPaymentId: z.string().min(1).optional(),
          amount: amountSchema.optional(),
          ...providerIdentityFields,
        })
        .parse(value);
      return {
        type: parsedBase.type,
        eventId: parsed.eventId,
        environment,
        externalOrderId: parsed.externalOrderId,
        ...optionalOrderReference(parsed),
        occurredAt,
        ...(parsed.currentPeriodStart
          ? { currentPeriodStart: new Date(parsed.currentPeriodStart) }
          : {}),
        ...(parsed.currentPeriodEnd ? { currentPeriodEnd: new Date(parsed.currentPeriodEnd) } : {}),
        ...(parsed.externalPaymentId ? { externalPaymentId: parsed.externalPaymentId } : {}),
        ...(parsed.amount ? { amount: parsedAmount(parsed.amount) } : {}),
        ...optionalProviderIdentity(parsed),
      };
    }
    case "refund_succeeded": {
      const parsed = v1Base
        .extend({
          externalPaymentId: z.string().min(1),
          externalRefundReference: z.string().min(1).optional(),
          merchantOrderReference: z.string().min(1).optional(),
          amount: amountSchema,
        })
        .parse(value);
      return {
        type: "refund_succeeded",
        eventId: parsed.eventId,
        environment,
        externalPaymentId: parsed.externalPaymentId,
        ...(parsed.externalRefundReference
          ? { externalRefundReference: parsed.externalRefundReference }
          : {}),
        ...optionalOrderReference(parsed),
        amount: parsedAmount(parsed.amount),
        occurredAt,
      };
    }
    case "refund_failed": {
      const parsed = v1Base
        .extend({
          externalPaymentId: z.string().min(1),
          externalRefundReference: z.string().min(1).optional(),
          merchantOrderReference: z.string().min(1).optional(),
        })
        .parse(value);
      return {
        type: "refund_failed",
        eventId: parsed.eventId,
        environment,
        externalPaymentId: parsed.externalPaymentId,
        ...(parsed.externalRefundReference
          ? { externalRefundReference: parsed.externalRefundReference }
          : {}),
        ...optionalOrderReference(parsed),
        occurredAt,
      };
    }
    case "unsupported_signed_event": {
      const parsed = v1Base.extend({ providerType: z.string().min(1) }).parse(value);
      return {
        type: "unsupported_signed_event",
        eventId: parsed.eventId,
        environment,
        providerType: parsed.providerType,
        occurredAt,
      };
    }
    default:
      throw new Error(`unsupported normalized event type: ${parsedBase.type}`);
  }
}

function parseLegacyV0NormalizedProviderEvent(
  value: Record<string, unknown>,
): NormalizedProviderEvent {
  const legacy = legacyV0Base.passthrough().parse(value);
  return parseV1NormalizedProviderEvent({ ...legacy, version: 1 });
}

export function parseNormalizedProviderEvent(value: unknown): NormalizedProviderEvent {
  const envelope = z.record(z.string(), z.unknown()).parse(value);
  if (!Object.hasOwn(envelope, "version")) {
    return parseLegacyV0NormalizedProviderEvent(envelope);
  }
  if (envelope.version === 1) return parseV1NormalizedProviderEvent(envelope);
  throw new Error(`unsupported normalized event version: ${String(envelope.version)}`);
}
