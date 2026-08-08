import type { Metadata } from "next";
import Link from "next/link";

import { Breadcrumbs } from "@/components/navigation/breadcrumbs";
import { JsonLd } from "@/components/seo/json-ld";
import { routeRegistry } from "@/config/routes.config";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForRoute } from "@/platform/seo/metadata";
import { breadcrumbJsonLd } from "@/platform/seo/structured-data";

export const metadata: Metadata = metadataForRoute(
  routeRegistry,
  "/pricing",
  currentSeoEnvironment(),
);

export default function PricingPage() {
  const route = routeRegistry.get("/pricing");
  if (route.class !== "public_indexable") throw new Error("pricing route must be indexable");

  return (
    <main className="page-shell">
      <JsonLd
        value={breadcrumbJsonLd([
          { name: "Home", url: routeRegistry.site.canonicalOrigin },
          { name: "Pricing", url: new URL("/pricing", routeRegistry.site.canonicalOrigin).toString() },
        ])}
      />
      <div className="content-width content-width--narrow">
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Pricing" }]} />
        <p className="eyebrow">Draft commercial shell</p>
        <h1>{route.h1}</h1>
        <p className="lead">
          This starter does not ship a fake price. Downstream products define reviewed server-side products,
          currencies, fulfillment keys and refund policy mappings before checkout is enabled.
        </p>
        <section className="pricing-card" aria-labelledby="pricing-contract-heading">
          <h2 id="pricing-contract-heading">Server-owned pricing contract</h2>
          <ul>
            <li>Local product key and immutable version</li>
            <li>Expected currency and decimal display amount</li>
            <li>Provider product ID scoped to environment</li>
            <li>Fulfillment and refund policy keys</li>
          </ul>
          <p>
            Browser-submitted amounts, provider IDs and entitlements are never authoritative. The commerce phase
            validates them against this server-owned catalog.
          </p>
        </section>
        <p>
          <Link href="/refund-policy">Read the refund-policy framework</Link> or <Link href="/terms">review the terms framework</Link>.
        </p>
      </div>
    </main>
  );
}
