import type { Metadata } from "next";

import { MagicLinkConfirmation } from "./magic-link-confirmation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm sign in",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function MagicLinkConfirmationPage() {
  return (
    <main className="shell">
      <section className="card" aria-labelledby="confirm-title">
        <p className="eyebrow">Security confirmation</p>
        <h1 id="confirm-title">Confirm sign in</h1>
        <MagicLinkConfirmation />
      </section>
    </main>
  );
}
