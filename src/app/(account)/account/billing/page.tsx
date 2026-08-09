import { desc, eq, inArray } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { RefundAction, SubscriptionAction } from "@/components/account/billing-actions";
import { featuresConfig } from "@/config/features.config";
import { getAccountContext } from "@/platform/auth/account-context";
import { formatDisplayAmount, type SupportedCurrency } from "@/platform/commerce/domain/money";
import { db } from "@/platform/database/application-database";
import { commerceProducts, orders, payments } from "@/platform/database/commerce-schema";
import { refunds, subscriptions } from "@/platform/database/subscription-schema";

export default async function BillingPage() {
  const context = await getAccountContext(await headers());
  if (!context) redirect("/sign-in");

  const history = await db.select({
    id: orders.id,
    status: orders.status,
    currency: orders.expectedCurrency,
    minor: orders.expectedMinor,
    createdAt: orders.createdAt,
    productKey: commerceProducts.key,
    productVersion: commerceProducts.version,
  }).from(orders).innerJoin(commerceProducts, eq(commerceProducts.id, orders.productId))
    .where(eq(orders.subjectId, context.subject.id)).orderBy(desc(orders.createdAt)).limit(50);

  const subscriptionRows = featuresConfig.commerce.subscriptions
    ? await db.select().from(subscriptions).where(eq(subscriptions.subjectId, context.subject.id)).orderBy(desc(subscriptions.createdAt)).limit(20)
    : [];

  const paymentRows = await db.select({ payment: payments, orderSubjectId: orders.subjectId })
    .from(payments).innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(orders.subjectId, context.subject.id)).orderBy(desc(payments.createdAt)).limit(50);
  const paymentIds = paymentRows.map((row) => row.payment.id);
  const refundRows = paymentIds.length === 0 ? [] : await db.select().from(refunds).where(inArray(refunds.paymentId, paymentIds)).orderBy(desc(refunds.createdAt)).limit(100);

  return (
    <main className="shell">
      <section className="card" aria-labelledby="billing-title">
        <p className="eyebrow">Account</p>
        <h1 id="billing-title">Billing</h1>

        {featuresConfig.commerce.subscriptions ? (
          <section aria-labelledby="subscriptions-title">
            <h2 id="subscriptions-title">Subscriptions</h2>
            {subscriptionRows.length === 0 ? <p>No subscriptions are recorded for this account.</p> : (
              <ul>
                {subscriptionRows.map((subscription) => (
                  <li key={subscription.id}>
                    <strong>{subscription.status}</strong>
                    {subscription.currentPeriodEnd ? <> · current period ends {subscription.currentPeriodEnd.toISOString()}</> : null}
                    {subscription.pastDueGraceEndsAt ? <> · grace ends {subscription.pastDueGraceEndsAt.toISOString()} ({subscription.gracePolicyVersion})</> : null}
                    {subscription.status === "active" || subscription.status === "past_due" ? <SubscriptionAction subscriptionId={subscription.id} action="cancel" /> : null}
                    {subscription.status === "canceling" ? <SubscriptionAction subscriptionId={subscription.id} action="resume" /> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <section aria-labelledby="payments-title">
          <h2 id="payments-title">Payments and refunds</h2>
          {paymentRows.length === 0 ? <p>No payments have been recorded for this account.</p> : (
            <ul>
              {paymentRows.map(({ payment }) => {
                const currency = payment.currency as SupportedCurrency;
                const refundableMinor = payment.amountMinor - payment.refundedMinor;
                return (
                  <li key={payment.id}>
                    <strong>{payment.status}</strong> · {formatDisplayAmount({ currency, minor: payment.amountMinor })} {payment.currency}
                    {payment.refundedMinor > 0n ? <> · refunded {formatDisplayAmount({ currency, minor: payment.refundedMinor })}</> : null}
                    {featuresConfig.commerce.enabled && refundableMinor > 0n && payment.status === "succeeded" ? (
                      <RefundAction paymentId={payment.id} currency={payment.currency} refundableAmount={formatDisplayAmount({ currency, minor: refundableMinor })} />
                    ) : null}
                    <ul>
                      {refundRows.filter((refund) => refund.paymentId === payment.id).map((refund) => (
                        <li key={refund.id}>Refund {refund.status} · requested {formatDisplayAmount({ currency, minor: refund.requestedMinor })} · entitlement {refund.reversalStatus}{refund.operatorReviewReason ? ` · ${refund.operatorReviewReason}` : ""}</li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="orders-title">
          <h2 id="orders-title">Order history</h2>
          {history.length === 0 ? <p>No orders have been recorded for this account.</p> : (
            <ul>{history.map((order) => <li key={order.id}><strong>{order.productKey}</strong> v{order.productVersion} · {order.status} · {formatDisplayAmount({ currency: order.currency as SupportedCurrency, minor: order.minor })} {order.currency} · {order.createdAt.toISOString()}</li>)}</ul>
          )}
        </section>
        <p><Link href="/account">Back to account</Link></p>
      </section>
    </main>
  );
}
