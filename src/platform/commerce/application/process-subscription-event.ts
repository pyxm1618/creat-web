import { and, eq } from "drizzle-orm";

import { subscriptionsConfig } from "@/config/subscriptions.config";
import { lockAccountSubject } from "@/platform/accounts/account-subject-commerce-fence";
import type { DatabaseClient } from "@/platform/database/client";
import {
  commerceProducts,
  commerceReconciliationRuns,
  fulfillmentJobs,
  orders,
  payments,
} from "@/platform/database/commerce-schema";
import { subscriptionPeriods, subscriptions } from "@/platform/database/subscription-schema";

import type { NormalizedProviderEvent } from "../domain/events";
import { equalMoney, type SupportedCurrency } from "../domain/money";
import { transitionOrder, type OrderStatus } from "../domain/order";
import {
  applySubscriptionTransition,
  type SubscriptionProjection,
  type SubscriptionStatus,
  type SubscriptionTransition,
} from "../domain/subscription";
import { guardSubscriptionEventForSubject } from "./subscription-account-deletion-policy";

type SubscriptionEvent = Extract<
  NormalizedProviderEvent,
  {
    type:
      | "subscription_activated"
      | "subscription_payment_succeeded"
      | "subscription_canceling"
      | "subscription_uncanceled"
      | "subscription_updated"
      | "subscription_canceled"
      | "subscription_past_due";
  }
>;

type CommerceTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

const RESURRECTION_EVENT_TYPES = new Set<SubscriptionEvent["type"]>([
  "subscription_activated",
  "subscription_payment_succeeded",
  "subscription_uncanceled",
]);

function parseOrderStatus(value: string): OrderStatus {
  if (
    value === "pending" ||
    value === "paid" ||
    value === "canceled" ||
    value === "partially_refunded" ||
    value === "refunded"
  ) {
    return value;
  }
  throw new Error(`invalid persisted order status: ${value}`);
}

function parseSubscriptionStatus(value: string): SubscriptionStatus {
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
  throw new Error(`invalid persisted subscription status: ${value}`);
}

function persistedProjection(row: typeof subscriptions.$inferSelect): SubscriptionProjection {
  return {
    status: parseSubscriptionStatus(row.status),
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    pastDueStartedAt: row.pastDueStartedAt,
    pastDueGraceEndsAt: row.pastDueGraceEndsAt,
    gracePolicyVersion: row.gracePolicyVersion,
  };
}

function transitionFor(event: SubscriptionEvent): SubscriptionTransition | undefined {
  switch (event.type) {
    case "subscription_activated":
      if (!event.currentPeriodStart || !event.currentPeriodEnd) {
        throw new Error("subscription activation requires period bounds");
      }
      return {
        type: "activated",
        occurredAt: event.occurredAt,
        periodStart: event.currentPeriodStart,
        periodEnd: event.currentPeriodEnd,
      };
    case "subscription_payment_succeeded":
      if (!event.currentPeriodStart || !event.currentPeriodEnd) {
        throw new Error("subscription renewal requires period bounds");
      }
      return {
        type: "payment_succeeded",
        occurredAt: event.occurredAt,
        periodStart: event.currentPeriodStart,
        periodEnd: event.currentPeriodEnd,
      };
    case "subscription_canceling":
      return { type: "canceling", occurredAt: event.occurredAt };
    case "subscription_uncanceled":
      return { type: "uncanceled", occurredAt: event.occurredAt };
    case "subscription_canceled":
      return { type: "canceled", occurredAt: event.occurredAt };
    case "subscription_past_due":
      return {
        type: "past_due",
        occurredAt: event.occurredAt,
        graceDays: subscriptionsConfig.pastDueGraceDays,
        gracePolicyVersion: subscriptionsConfig.gracePolicyVersion,
      };
    case "subscription_updated":
      return undefined;
  }
}

async function findOrder(tx: CommerceTransaction, event: SubscriptionEvent) {
  if (event.merchantOrderReference) {
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(eq(orders.id, event.merchantOrderReference), eq(orders.environment, event.environment)),
      )
      .limit(1);
    if (!order) throw new Error("subscription order not found for merchant reference");
    if (order.externalOrderId && order.externalOrderId !== event.externalOrderId) {
      throw new Error("subscription provider order id mismatch");
    }
    return order;
  }
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.environment, event.environment),
        eq(orders.externalOrderId, event.externalOrderId),
      ),
    )
    .limit(1);
  if (!order) throw new Error("subscription order not found for provider event");
  return order;
}

async function lockOrder(tx: CommerceTransaction, event: SubscriptionEvent) {
  if (event.merchantOrderReference) {
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(eq(orders.id, event.merchantOrderReference), eq(orders.environment, event.environment)),
      )
      .limit(1)
      .for("update");
    if (!order) throw new Error("subscription order not found for merchant reference");
    if (order.externalOrderId && order.externalOrderId !== event.externalOrderId) {
      throw new Error("subscription provider order id mismatch");
    }
    return order;
  }
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.environment, event.environment),
        eq(orders.externalOrderId, event.externalOrderId),
      ),
    )
    .limit(1)
    .for("update");
  if (!order) throw new Error("subscription order not found for provider event");
  return order;
}

export async function processSubscriptionEvent(
  tx: CommerceTransaction,
  event: SubscriptionEvent,
  payloadHash: string,
): Promise<void> {
  const discoveredOrder = await findOrder(tx, event);
  const subject = await lockAccountSubject(tx, discoveredOrder.subjectId);
  const order = await lockOrder(tx, event);
  if (order.subjectId !== subject.id) throw new Error("subscription order subject changed");
  const resurrectionEvent = RESURRECTION_EVENT_TYPES.has(event.type);
  let [subscription] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.orderId, order.id))
    .limit(1)
    .for("update");

  await guardSubscriptionEventForSubject({
    subject,
    eventType: event.type,
    ...(subscription ? { subscriptionStatus: parseSubscriptionStatus(subscription.status) } : {}),
    reconcile: async () => {
      await tx.insert(commerceReconciliationRuns).values({
        targetType: "subscription_account_deletion_fence",
        targetId: event.externalOrderId,
        actorType: "webhook",
        beforeJson: {
          eventId: event.eventId,
          eventType: event.type,
          orderId: order.id,
          subjectId: subject.id,
          subjectStatus: subject.status,
        },
        afterJson: {
          action: resurrectionEvent ? "ignored_resurrection_event" : "ignored_nonterminal_event",
          subscriptionMutationApplied: false,
        },
        result: resurrectionEvent ? "resurrection_blocked" : "nonterminal_transition_blocked",
      });
    },
    apply: async () => {
      const [product] = await tx
        .select()
        .from(commerceProducts)
        .where(eq(commerceProducts.id, order.productId))
        .limit(1);
      if (!product || product.model !== "subscription") {
        throw new Error("subscription event targets a non-subscription product");
      }

      if (!subscription) {
        [subscription] = await tx
          .insert(subscriptions)
          .values({
            orderId: order.id,
            subjectId: order.subjectId,
            environment: event.environment,
            externalOrderId: event.externalOrderId,
            status: "pending",
            providerUpdatedAt: event.occurredAt,
          })
          .returning();
      }
      if (!subscription) throw new Error("subscription projection insert failed");

      const staleProjectionEvent = Boolean(
        subscription.providerUpdatedAt && event.occurredAt < subscription.providerUpdatedAt,
      );
      if (!staleProjectionEvent) {
        const transition = transitionFor(event);
        let projection = persistedProjection(subscription);
        if (transition) projection = applySubscriptionTransition(projection, transition);
        if (event.type === "subscription_updated") {
          projection = {
            ...projection,
            currentPeriodStart: event.currentPeriodStart ?? projection.currentPeriodStart,
            currentPeriodEnd: event.currentPeriodEnd ?? projection.currentPeriodEnd,
          };
        }

        await tx
          .update(subscriptions)
          .set({
            status: projection.status,
            cancelAtPeriodEnd: projection.cancelAtPeriodEnd,
            currentPeriodStart: projection.currentPeriodStart,
            currentPeriodEnd: projection.currentPeriodEnd,
            pastDueStartedAt: projection.pastDueStartedAt,
            pastDueGraceEndsAt: projection.pastDueGraceEndsAt,
            gracePolicyVersion: projection.gracePolicyVersion,
            providerUpdatedAt: event.occurredAt,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.id, subscription.id));
      }

      if (
        event.type === "subscription_activated" ||
        event.type === "subscription_payment_succeeded"
      ) {
        await tx
          .update(orders)
          .set({
            status: transitionOrder(parseOrderStatus(order.status), "payment_succeeded"),
            externalOrderId: order.externalOrderId ?? event.externalOrderId,
            paidAt: order.paidAt ?? event.occurredAt,
          })
          .where(eq(orders.id, order.id));
      }

      if (!event.externalPaymentId || !event.amount) return;
      const expected = {
        currency: order.expectedCurrency as SupportedCurrency,
        minor: order.expectedMinor,
      };
      if (!equalMoney(expected, event.amount))
        throw new Error("subscription payment amount mismatch");

      let [payment] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.environment, event.environment),
            eq(payments.externalPaymentId, event.externalPaymentId),
          ),
        )
        .limit(1)
        .for("update");
      if (!payment) {
        [payment] = await tx
          .insert(payments)
          .values({
            orderId: order.id,
            environment: event.environment,
            externalPaymentId: event.externalPaymentId,
            status: "succeeded",
            refundStatus: "none",
            currency: event.amount.currency,
            amountMinor: event.amount.minor,
            refundedMinor: 0n,
            providerCreatedAt: event.occurredAt,
            rawPayloadHash: payloadHash,
          })
          .returning();
      } else if (
        payment.orderId !== order.id ||
        payment.currency !== event.amount.currency ||
        payment.amountMinor !== event.amount.minor
      ) {
        throw new Error("subscription payment identity mismatch");
      }
      if (!payment) throw new Error("subscription payment projection failed");

      if (event.currentPeriodStart && event.currentPeriodEnd) {
        await tx
          .insert(subscriptionPeriods)
          .values({
            subscriptionId: subscription.id,
            paymentId: payment.id,
            periodStart: event.currentPeriodStart,
            periodEnd: event.currentPeriodEnd,
            state: "paid",
          })
          .onConflictDoNothing({
            target: [
              subscriptionPeriods.subscriptionId,
              subscriptionPeriods.periodStart,
              subscriptionPeriods.periodEnd,
            ],
          });
      }

      const operation = `fulfill:${product.fulfillmentKey}`;
      await tx
        .insert(fulfillmentJobs)
        .values({
          sourceType: "subscription_payment",
          sourceId: event.externalPaymentId,
          operation,
          idempotencyKey: `subscription-payment:${event.environment}:${event.externalPaymentId}:${operation}`,
        })
        .onConflictDoNothing({ target: fulfillmentJobs.idempotencyKey });
    },
  });
}
