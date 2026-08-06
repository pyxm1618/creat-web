import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account deleted",
  robots: { index: false, follow: false },
};

export default function AccountDeletedPage() {
  return (
    <main className="shell">
      <section className="card" aria-labelledby="deleted-title">
        <p className="eyebrow">Account lifecycle</p>
        <h1 id="deleted-title">Account deleted</h1>
        <p>Your authentication access has been removed and all sessions have been revoked.</p>
        <p>
          <a href="/">Return to the homepage</a>
        </p>
      </section>
    </main>
  );
}
