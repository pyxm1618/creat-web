import { headers } from "next/headers";
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
        <p>
          <a href="/account/security">Manage sessions and account deletion</a>
        </p>
      </section>
    </main>
  );
}
