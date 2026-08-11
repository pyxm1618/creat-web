import { and, eq, lt, or } from "drizzle-orm";

import {
  lockAccountSubject,
  requireActiveAccountSubject,
} from "@/platform/accounts/account-subject-commerce-fence";
import type { DatabaseClient } from "@/platform/database/client";
import { commerceReconciliationRuns, orders } from "@/platform/database/commerce-schema";

import { CheckoutRequiresOperatorReviewError } from "./checkout-errors";
import { runFencedCheckout } from "./fenced-checkout";
import type { ProductCatalog } from "./product-catalog";
import type { CreatedCheckout, PaymentProvider } from "./payment-provider";
import { ensureCommerceProduct } from "./sync-product-catalog";
import type { CommerceEnvironment } from "../domain/product";
import { isCommerceIdempotencyKey } from "../domain/idempotency-key";

export type CreateCheckoutInput = {
  readonly subjectId: string;
  readonly buyerIdentity: string;
  readonly buyerEmail?: string;
  readonly productKey: string;
  readonly environment: CommerceEnvironment;
  readonly idempotencyKey: string;
  readonly appOrigin: string;
  readonly now?: Date;
};

export type CheckoutResult = {
  readonly orderId: string;
  readonly checkoutUrl: string;
  readonly reused: boolean;
};

const CHECKOUT_LEASE_MS = 2 * 60 * 1000;

function validateIdempotencyKey(value: string): void {
  if (!isCommerceIdempotencyKey(value)) throw new Error("invalid checkout idempotency key");
}

export async function createCheckout(
  input: CreateCheckoutInput,
  dependencies: {
    readonly database: DatabaseClient;
    readonly catalog: ProductCatalog;
    readonly provider: PaymentProvider;
  },
): Promise<CheckoutResult> {
  validateIdempotencyKey(input.idempotencyKey);
  const { database, catalog, provider } = dependencies;
  const now = input.now ?? new Date();
  const snapshot = catalog.getEnabled(input.productKey, input.environment);
  if (snapshot.commercialModel === "one_time" && !provider.capabilities.oneTime) {
    throw new Error("payment provider does not support one-time purchases");
  }
  if (snapshot.commercialModel === "subscription" && !provider.capabilities.subscriptions) {
    throw new Error("payment provider does not support subscriptions");
  }
  const product = await ensureCommerceProduct(database, snapshot, input.environment);

  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + CHECKOUT_LEASE_MS);
  let providerCheckout: CreatedCheckout | undefined;

  return runFencedCheckout({
    claimWhileSubjectActive: () =>
      database.transaction(async (transaction) => {
        requireActiveAccountSubject(await lockAccountSubject(transaction, input.subjectId));
        const [inserted] = await transaction
          .insert(orders)
          .values({
            subjectId: input.subjectId,
            productId: product.id,
            environment: input.environment,
            expectedCurrency: snapshot.expected.currency,
            expectedMinor: snapshot.expected.minor,
            checkoutIdempotencyKey: input.idempotencyKey,
            checkoutState: "creating",
            checkoutLeaseToken: leaseToken,
            checkoutLeaseExpiresAt: leaseExpiresAt,
          })
          .onConflictDoNothing({ target: orders.checkoutIdempotencyKey })
          .returning();
        if (inserted) return { order: inserted, reused: false };

        const existing = await transaction.query.orders.findFirst({
          where: eq(orders.checkoutIdempotencyKey, input.idempotencyKey),
        });
        if (!existing) throw new Error("checkout idempotency resolution failed");
        if (existing.subjectId !== input.subjectId)
          throw new Error("checkout idempotency collision");
        if (existing.productId !== product.id || existing.environment !== input.environment) {
          throw new Error("checkout idempotency key reused for different product");
        }
        if (existing.checkoutState === "created") throw new Error("checkout already created");
        if (existing.checkoutState === "failed" && existing.externalCheckoutSessionId) {
          throw new CheckoutRequiresOperatorReviewError();
        }
        if (
          existing.checkoutState === "creating" &&
          existing.checkoutLeaseExpiresAt &&
          existing.checkoutLeaseExpiresAt > now
        ) {
          throw new Error("checkout initialization in progress");
        }

        const [claimed] = await transaction
          .update(orders)
          .set({
            checkoutState: "creating",
            checkoutLeaseToken: leaseToken,
            checkoutLeaseExpiresAt: leaseExpiresAt,
          })
          .where(
            and(
              eq(orders.id, existing.id),
              or(
                eq(orders.checkoutState, "failed"),
                and(eq(orders.checkoutState, "creating"), lt(orders.checkoutLeaseExpiresAt, now)),
              ),
            ),
          )
          .returning();
        if (!claimed) throw new Error("checkout initialization in progress");
        return { order: claimed, reused: true };
      }),
    callProvider: async ({ order }) => {
      const successUrl = new URL(
        `/checkout/return?order=${encodeURIComponent(order.id)}`,
        input.appOrigin,
      ).toString();
      const cancelUrl = new URL(
        `/checkout/return?order=${encodeURIComponent(order.id)}&canceled=1`,
        input.appOrigin,
      ).toString();
      const checkout = await provider.createCheckout({
        model: snapshot.commercialModel,
        localOrderId: order.id,
        providerProductId: snapshot.providerProductId,
        expectedDisplayAmount: snapshot.expectedDisplayAmount,
        currency: snapshot.expected.currency,
        buyerIdentity: input.buyerIdentity,
        ...(input.buyerEmail ? { buyerEmail: input.buyerEmail } : {}),
        successUrl,
        cancelUrl,
      });
      providerCheckout = checkout;
      const target = new URL(checkout.checkoutUrl);
      if (target.protocol !== "https:") throw new Error("provider checkout URL must use HTTPS");
      return checkout;
    },
    commitWhileSubjectActive: ({ order, reused }, checkout) =>
      database.transaction(async (transaction) => {
        requireActiveAccountSubject(await lockAccountSubject(transaction, input.subjectId));
        const [committed] = await transaction
          .update(orders)
          .set({
            checkoutState: "created",
            checkoutLeaseToken: null,
            checkoutLeaseExpiresAt: null,
            externalCheckoutSessionId: checkout.externalCheckoutSessionId,
            ...(checkout.externalOrderId ? { externalOrderId: checkout.externalOrderId } : {}),
          })
          .where(and(eq(orders.id, order.id), eq(orders.checkoutLeaseToken, leaseToken)))
          .returning({ id: orders.id });
        if (!committed) throw new Error("checkout lease lost before commit");
        return { orderId: order.id, checkoutUrl: checkout.checkoutUrl, reused };
      }),
    failClaim: async ({ order }) => {
      const abandonedCheckout = providerCheckout;
      if (abandonedCheckout) {
        await database.transaction(async (transaction) => {
          const [failed] = await transaction
            .update(orders)
            .set({
              checkoutState: "failed",
              checkoutLeaseToken: null,
              checkoutLeaseExpiresAt: null,
              externalCheckoutSessionId: abandonedCheckout.externalCheckoutSessionId,
              ...(abandonedCheckout.externalOrderId
                ? { externalOrderId: abandonedCheckout.externalOrderId }
                : {}),
            })
            .where(and(eq(orders.id, order.id), eq(orders.checkoutLeaseToken, leaseToken)))
            .returning({ id: orders.id });
          await transaction.insert(commerceReconciliationRuns).values({
            targetType: "checkout_session",
            targetId: abandonedCheckout.externalCheckoutSessionId,
            actorType: "application",
            beforeJson: {
              orderId: order.id,
              subjectId: input.subjectId,
              checkoutState: "creating",
            },
            afterJson: {
              externalCheckoutSessionId: abandonedCheckout.externalCheckoutSessionId,
              externalOrderId: abandonedCheckout.externalOrderId ?? null,
              checkoutUrlReturned: false,
              localCheckoutState: "failed",
              orderIdentifiersPersisted: Boolean(failed),
            },
            result: "operator_review_required",
          });
        });
        return;
      }
      await database
        .update(orders)
        .set({ checkoutState: "failed", checkoutLeaseToken: null, checkoutLeaseExpiresAt: null })
        .where(and(eq(orders.id, order.id), eq(orders.checkoutLeaseToken, leaseToken)));
    },
  });
}
