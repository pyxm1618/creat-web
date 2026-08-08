import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getAccountContext } from "@/platform/auth/account-context";

export default async function AccountPage() {
  const context = await getAccountContext(await headers());
  if (!context) redirect("/sign-in");

  return (
    <main className="shell">
      <section className="card" aria-labelledby="account-title">
        <p className="eyebrow">Account</p>
        <h1 id="account-title">Welcome, {context.user.name}</h1>
        <p>{context.user.email}</p>
        <nav aria-label="Account navigation">
          <Link href="/account/credits">Credits</Link> ·{" "}
          <Link href="/account/billing">Billing history</Link> ·{" "}
          <Link href="/account/security">Security and account deletion</Link>
        </nav>
      </section>
    </main>
  );
}
