import { desc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountShell } from "@/components/account/account-shell";
import {
  bodyText,
  cardTitle,
  inlineLink,
  listDivided,
  metaText,
  panel,
  subTitle,
} from "@/components/ui/styles";
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
    <AccountShell eyebrow="Account" title="Credits" titleId="credits-title">
      {balances.length === 0 ? (
        <p className={bodyText}>No credit grants have been recorded for this account.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {balances.map(({ creditType, balance }) => (
            <div key={creditType} className={`${panel} p-5`}>
              <p className={cardTitle}>{creditType}</p>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {(
                  [
                    ["Available", balance.available],
                    ["Reserved", balance.reserved],
                    ["Consumed", balance.consumed],
                    ["Expired", balance.expired],
                    ["Revoked", balance.revoked],
                  ] as const
                ).map(([term, value]) => (
                  <div key={term} className="flex justify-between gap-2">
                    <dt className="text-muted">{term}</dt>
                    <dd className="font-medium text-foreground">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}

      <h2 className={`mt-12 ${subTitle}`}>Recent ledger activity</h2>
      {history.length === 0 ? (
        <p className={`mt-3 ${bodyText}`}>No ledger activity.</p>
      ) : (
        <ul className={`mt-4 ${panel} ${listDivided} px-5`}>
          {history.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
              <span className="text-sm font-medium text-foreground">
                {entry.creditType} · {entry.entryType}
              </span>
              <span className={metaText}>
                {entry.quantity} · {entry.createdAt.toISOString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8">
        <Link href="/account" className={inlineLink}>
          Back to account
        </Link>
      </p>
    </AccountShell>
  );
}
