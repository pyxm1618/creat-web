import { desc, eq, inArray } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountShell } from "@/components/account/account-shell";
import { RefundAction, SubscriptionAction } from "@/components/account/billing-actions";
import {
  bodyText,
  inlineLink,
  listDivided,
  metaText,
  panel,
  subTitle,
} from "@/components/ui/styles";
import { featuresConfig } from "@/config/features.config";
import { getAccountContext } from "@/platform/auth/account-context";
import { formatDisplayAmount, type SupportedCurrency } from "@/platform/commerce/domain/money";
import { db } from "@/platform/database/application-database";
import { commerceProducts, orders, payments } from "@/platform/database/commerce-schema";
import { refunds, subscriptions } from "@/platform/database/subscription-schema";

export default async function BillingPage() {
  const context = await getAccountContext(await headers());
  if (!context) redirect("/sign-in");

  const history = await db
    .select({
      id: orders.id,
      status: orders.status,
      currency: orders.expectedCurrency,
      minor: orders.expectedMinor,
      createdAt: orders.createdAt,
      productKey: commerceProducts.key,
      productVersion: commerceProducts.version,
      billingInterval: commerceProducts.billingInterval,
    })
    .from(orders)
    .innerJoin(commerceProducts, eq(commerceProducts.id, orders.productId))
    .where(eq(orders.subjectId, context.subject.id))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  const subscriptionRows = featuresConfig.commerce.subscriptions
    ? await db
        .select({
          subscription: subscriptions,
          productKey: commerceProducts.key,
          billingInterval: commerceProducts.billingInterval,
        })
        .from(subscriptions)
        .innerJoin(orders, eq(orders.id, subscriptions.orderId))
        .innerJoin(commerceProducts, eq(commerceProducts.id, orders.productId))
        .where(eq(subscriptions.subjectId, context.subject.id))
        .orderBy(desc(subscriptions.createdAt))
        .limit(20)
    : [];

  const paymentRows = await db
    .select({ payment: payments, orderSubjectId: orders.subjectId })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(orders.subjectId, context.subject.id))
    .orderBy(desc(payments.createdAt))
    .limit(50);
  const paymentIds = paymentRows.map((row) => row.payment.id);
  const refundRows =
    paymentIds.length === 0
      ? []
      : await db
          .select()
          .from(refunds)
          .where(inArray(refunds.paymentId, paymentIds))
          .orderBy(desc(refunds.createdAt))
          .limit(100);

  return (
    <AccountShell eyebrow="Account" title="Billing" titleId="billing-title">
      {featuresConfig.commerce.subscriptions ? (
        <section aria-labelledby="subscriptions-title">
          <h2 id="subscriptions-title" className={subTitle}>
            Subscriptions
          </h2>
          {subscriptionRows.length === 0 ? (
            <p className={`mt-3 ${bodyText}`}>No subscriptions are recorded for this account.</p>
          ) : (
            <ul className={`mt-4 ${panel} ${listDivided} px-5`}>
              {subscriptionRows.map(({ subscription, productKey, billingInterval }) => (
                <li key={subscription.id} className="py-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-foreground">{productKey}</span>
                    <span className="rounded-md bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted">
                      {subscription.status}
                    </span>
                    {billingInterval ? <span className={metaText}>{billingInterval}ly</span> : null}
                  </div>
                  {subscription.currentPeriodEnd ? (
                    <p className={`mt-1 ${metaText}`}>
                      Current period ends {subscription.currentPeriodEnd.toISOString()}
                    </p>
                  ) : null}
                  {subscription.pastDueGraceEndsAt ? (
                    <p className={`mt-1 ${metaText}`}>
                      Grace ends {subscription.pastDueGraceEndsAt.toISOString()} (
                      {subscription.gracePolicyVersion})
                    </p>
                  ) : null}
                  {subscription.status === "active" || subscription.status === "past_due" ? (
                    <SubscriptionAction subscriptionId={subscription.id} action="cancel" />
                  ) : null}
                  {subscription.status === "canceling" ? (
                    <SubscriptionAction subscriptionId={subscription.id} action="resume" />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section aria-labelledby="payments-title" className="mt-12">
        <h2 id="payments-title" className={subTitle}>
          Payments and refunds
        </h2>
        {paymentRows.length === 0 ? (
          <p className={`mt-3 ${bodyText}`}>No payments have been recorded for this account.</p>
        ) : (
          <ul className={`mt-4 ${panel} ${listDivided} px-5`}>
            {paymentRows.map(({ payment }) => {
              const currency = payment.currency as SupportedCurrency;
              const refundableMinor = payment.amountMinor - payment.refundedMinor;
              const paymentRefunds = refundRows.filter((r) => r.paymentId === payment.id);
              return (
                <li key={payment.id} className="py-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="rounded-md bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted">
                      {payment.status}
                    </span>
                    <span className="text-sm font-medium text-foreground">
                      {formatDisplayAmount({ currency, minor: payment.amountMinor })}{" "}
                      {payment.currency}
                    </span>
                    {payment.refundedMinor > 0n ? (
                      <span className={metaText}>
                        refunded {formatDisplayAmount({ currency, minor: payment.refundedMinor })}
                      </span>
                    ) : null}
                  </div>
                  {featuresConfig.commerce.enabled &&
                  refundableMinor > 0n &&
                  payment.status === "succeeded" ? (
                    <RefundAction
                      paymentId={payment.id}
                      currency={payment.currency}
                      refundableAmount={formatDisplayAmount({ currency, minor: refundableMinor })}
                    />
                  ) : null}
                  {paymentRefunds.length > 0 ? (
                    <ul className="mt-3 space-y-1 border-l-2 border-border pl-4">
                      {paymentRefunds.map((refund) => (
                        <li key={refund.id} className={metaText}>
                          Refund {refund.status} · requested{" "}
                          {formatDisplayAmount({ currency, minor: refund.requestedMinor })} ·
                          entitlement {refund.reversalStatus}
                          {refund.operatorReviewReason ? ` · ${refund.operatorReviewReason}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="orders-title" className="mt-12">
        <h2 id="orders-title" className={subTitle}>
          Order history
        </h2>
        {history.length === 0 ? (
          <p className={`mt-3 ${bodyText}`}>No orders have been recorded for this account.</p>
        ) : (
          <ul className={`mt-4 ${panel} ${listDivided} px-5`}>
            {history.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-baseline justify-between gap-3 py-3"
              >
                <span className="text-sm font-medium text-foreground">
                  {order.productKey} v{order.productVersion}
                  {order.billingInterval ? ` · ${order.billingInterval}ly` : ""}
                </span>
                <span className={metaText}>
                  {order.status} ·{" "}
                  {formatDisplayAmount({
                    currency: order.currency as SupportedCurrency,
                    minor: order.minor,
                  })}{" "}
                  {order.currency} · {order.createdAt.toISOString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-8">
        <Link href="/account" className={inlineLink}>
          Back to account
        </Link>
      </p>
    </AccountShell>
  );
}
