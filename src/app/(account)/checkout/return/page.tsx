import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getAccountContext } from "@/platform/auth/account-context";
import { db } from "@/platform/database/application-database";
import { orders } from "@/platform/database/commerce-schema";

export default async function CheckoutReturnPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const context = await getAccountContext(await headers());
  if (!context) redirect("/sign-in");
  const params = await searchParams;
  const orderId = typeof params.order === "string" ? params.order : "";

  const order = orderId
    ? await db.query.orders.findFirst({
        where: and(eq(orders.id, orderId), eq(orders.subjectId, context.subject.id)),
      })
    : null;

  return (
    <main className="shell">
      <section className="card" aria-labelledby="checkout-return-title">
        <p className="eyebrow">Payment return</p>
        <h1 id="checkout-return-title">Payment status</h1>
        {order ? (
          <>
            <p>
              Current server-recorded status: <strong>{order.status}</strong>.
            </p>
            <p>
              Browser return parameters are advisory only. A payment becomes successful only after a
              verified provider event or reconciliation updates the server ledger.
            </p>
          </>
        ) : (
          <p>The requested order was not found for this account.</p>
        )}
        <p>
          <Link href="/account/billing">View billing history</Link>
        </p>
      </section>
    </main>
  );
}
