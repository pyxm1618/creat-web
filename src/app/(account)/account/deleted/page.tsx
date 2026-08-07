import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account deletion submitted",
  robots: { index: false, follow: false },
};

export default function AccountDeletedPage() {
  return (
    <main className="shell">
      <section className="card" aria-labelledby="deleted-title">
        <p className="eyebrow">Account lifecycle</p>
        <h1 id="deleted-title">Account deletion submitted</h1>
        <p>
          Access to account-scoped product data is blocked immediately. The deletion workflow runs
          now and retries durable downstream cleanup automatically if a dependency is temporarily
          unavailable.
        </p>
        <p>
          <a href="/">Return to the homepage</a>
        </p>
      </section>
    </main>
  );
}
