import Link from "next/link";

export function PricingSection({ title }: Readonly<{ title: string }>) {
  return (
    <section className="section section--muted" aria-labelledby="pricing-preview-heading">
      <div className="content-width two-column">
        <div>
          <p className="section-kicker">Commercial model</p>
          <h2 id="pricing-preview-heading">{title}</h2>
          <p>
            Pricing is owned by the server-side product catalog. The starter does not trust client-submitted
            amounts, currencies, product identifiers, or entitlements.
          </p>
        </div>
        <div className="demo-panel">
          <strong>Project-defined pricing</strong>
          <p>Replace the draft catalog with reviewed product facts before production release.</p>
          <Link href="/pricing">Review the pricing structure</Link>
        </div>
      </div>
    </section>
  );
}
