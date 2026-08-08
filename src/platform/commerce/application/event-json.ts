import { z } from "zod";

import type { NormalizedProviderEvent } from "../domain/events";
import type { CommerceEnvironment } from "../domain/product";

const amountSchema = z.object({
  currency: z.string().min(3).max(3),
  minor: z.string().regex(/^\d+$/),
});
const base = z.object({
  type: z.string(),
  eventId: z.string().min(1),
  environment: z.enum(["test", "production"]),
  occurredAt: z.iso.datetime(),
});

export function parseNormalizedProviderEvent(
  payload: Record<string, unknown>,
): NormalizedProviderEvent {
  const parsedBase = base.parse(payload);
  const environment = parsedBase.environment as CommerceEnvironment;
  const occurredAt = new Date(parsedBase.occurredAt);

  switch (parsedBase.type) {
    case "one_time_payment_succeeded": {
      const parsed = base
        .extend({
          externalOrderId: z.string().min(1),
          externalPaymentId: z.string().min(1),
          amount: amountSchema,
          merchantId: z.string().optional(),
          storeId: z.string().optional(),
        })
        .parse(payload);
      return {
        type: "one_time_payment_succeeded",
        eventId: parsed.eventId,
        environment,
        externalOrderId: parsed.externalOrderId,
        externalPaymentId: parsed.externalPaymentId,
        amount: { currency: parsed.amount.currency as never, minor: BigInt(parsed.amount.minor) },
        occurredAt,
        ...(parsed.merchantId ? { merchantId: parsed.merchantId } : {}),
        ...(parsed.storeId ? { storeId: parsed.storeId } : {}),
      };
    }
    case "one_time_payment_failed":
    case "one_time_payment_canceled": {
      const parsed = base
        .extend({ externalOrderId: z.string().min(1), externalPaymentId: z.string().optional() })
        .parse(payload);
      return {
        type: parsedBase.type,
        eventId: parsed.eventId,
        environment,
        externalOrderId: parsed.externalOrderId,
        occurredAt,
        ...(parsed.externalPaymentId ? { externalPaymentId: parsed.externalPaymentId } : {}),
      };
    }
    case "refund_succeeded": {
      const parsed = base
        .extend({ externalPaymentId: z.string().min(1), amount: amountSchema })
        .parse(payload);
      return {
        type: "refund_succeeded",
        eventId: parsed.eventId,
        environment,
        externalPaymentId: parsed.externalPaymentId,
        amount: { currency: parsed.amount.currency as never, minor: BigInt(parsed.amount.minor) },
        occurredAt,
      };
    }
    case "refund_failed": {
      const parsed = base.extend({ externalPaymentId: z.string().min(1) }).parse(payload);
      return {
        type: "refund_failed",
        eventId: parsed.eventId,
        environment,
        externalPaymentId: parsed.externalPaymentId,
        occurredAt,
      };
    }
    case "unsupported_signed_event": {
      const parsed = base.extend({ providerType: z.string().min(1) }).parse(payload);
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
