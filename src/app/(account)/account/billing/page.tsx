import { desc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getAccountContext } from "@/platform/auth/account-context";
import { db } from "@/platform/database/application-database";
import { commerceProducts, orders } from "@/platform/database/commerce-schema";
import { formatDisplayAmount, type SupportedCurrency } from "@/platform/commerce/domain/money";

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
    })
    .from(orders)
    .innerJoin(commerceProducts, eq(commerceProducts.id, orders.productId))
    .where(eq(orders.subjectId, context.subject.id))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  return (
    <main className="shell">
      <section className="card" aria-labelledby="billing-title">
        <p className="eyebrow">Account</p>
        <h1 id="billing-title">Billing history</h1>
        {history.length === 0 ? (
          <p>No orders have been recorded for this account.</p>
        ) : (
          <ul>
            {history.map((order) => (
              <li key={order.id}>
                <strong>{order.productKey}</strong> v{order.productVersion} · {order.status} ·{" "}
                {formatDisplayAmount({
                  currency: order.currency as SupportedCurrency,
                  minor: order.minor,
                })}{" "}
                {order.currency} · {order.createdAt.toISOString()}
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link href="/account">Back to account</Link>
        </p>
      </section>
    </main>
  );
}
