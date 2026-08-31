import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountShell } from "@/components/account/account-shell";
import { bodyText, card, cardTitle } from "@/components/ui/styles";
import { getAccountContext } from "@/platform/auth/account-context";

const destinations = [
  { href: "/account/credits", label: "Credits", body: "Balances and recent ledger activity." },
  {
    href: "/account/billing",
    label: "Billing history",
    body: "Subscriptions, payments and refunds.",
  },
  {
    href: "/account/security",
    label: "Security and account deletion",
    body: "Active sessions and account deletion.",
  },
] as const;

export default async function AccountPage() {
  const context = await getAccountContext(await headers());
  if (!context) redirect("/sign-in");

  return (
    <AccountShell
      eyebrow="Account"
      title={`Welcome, ${context.user.name}`}
      titleId="account-title"
      intro={context.user.email}
    >
      <nav aria-label="Account navigation" className="grid gap-4 sm:grid-cols-2">
        {destinations.map((item) => (
          <Link key={item.href} href={item.href} className={`${card} block hover:border-accent`}>
            <span className={cardTitle}>{item.label}</span>
            <span className={`mt-2 block ${bodyText}`}>{item.body}</span>
          </Link>
        ))}
      </nav>
    </AccountShell>
  );
}
