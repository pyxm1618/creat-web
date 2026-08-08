import type { Metadata } from "next";

import { Breadcrumbs } from "@/components/navigation/breadcrumbs";
import { legalConfig } from "@/config/legal.config";
import { routeRegistry } from "@/config/routes.config";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForRoute } from "@/platform/seo/metadata";

export const metadata: Metadata = metadataForRoute(
  routeRegistry,
  "/contact",
  currentSeoEnvironment(),
);

export default function ContactPage() {
  return (
    <main className="legal-page">
      <div className="content-width content-width--narrow">
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Contact" }]} />
        <p className="eyebrow">Project contact</p>
        <h1>Contact</h1>
        <p>
          The starter currently uses draft operator facts. Replace the address below with the
          reviewed production support channel before launch.
        </p>
        <p>
          <a href={`mailto:${legalConfig.operator.supportEmail}`}>
            {legalConfig.operator.supportEmail}
          </a>
        </p>
      </div>
    </main>
  );
}
