import { desc, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getAccountContext } from "@/platform/auth/account-context";
import { getCreditBalance } from "@/platform/credits/application/credit-service";
import { db } from "@/platform/database/application-database";
import { creditGrants, creditLedgerEntries } from "@/platform/database/credit-schema";

export default async function CreditsPage() {
  const context = await getAccountContext(await headers());
  if (!context) redirect("/sign-in");

  const types = await db
    .selectDistinct({ creditType: creditGrants.creditType })
    .from(creditGrants)
    .where(eq(creditGrants.subjectId, context.subject.id));
  const balances = await Promise.all(
    types.map(async ({ creditType }) => ({
      creditType,
      balance: await getCreditBalance(db, {
        subjectId: context.subject.id,
        creditType,
      }),
    })),
  );
  const history = await db
    .select({
      id: creditLedgerEntries.id,
      creditType: creditLedgerEntries.creditType,
      entryType: creditLedgerEntries.entryType,
      quantity: creditLedgerEntries.quantity,
      createdAt: creditLedgerEntries.createdAt,
    })
    .from(creditLedgerEntries)
    .where(eq(creditLedgerEntries.subjectId, context.subject.id))
    .orderBy(desc(creditLedgerEntries.createdAt))
    .limit(50);

  return (
    <main className="shell">
      <section className="card" aria-labelledby="credits-title">
        <p className="eyebrow">Account</p>
        <h1 id="credits-title">Credits</h1>
        {balances.length === 0 ? (
          <p>No credit grants have been recorded for this account.</p>
        ) : (
          <ul>
            {balances.map(({ creditType, balance }) => (
              <li key={creditType}>
                <strong>{creditType}</strong>: {balance.available} available, {balance.reserved} reserved,{" "}
                {balance.consumed} consumed, {balance.expired} expired, {balance.revoked} revoked.
              </li>
            ))}
          </ul>
        )}
        <h2>Recent ledger activity</h2>
        {history.length === 0 ? (
          <p>No ledger activity.</p>
        ) : (
          <ul>
            {history.map((entry) => (
              <li key={entry.id}>
                {entry.createdAt.toISOString()} · {entry.creditType} · {entry.entryType} · {entry.quantity}
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
