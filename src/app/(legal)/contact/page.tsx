import type { Metadata } from "next";

import { Breadcrumbs } from "@/components/navigation/breadcrumbs";
import { bodyText, containerNarrow, eyebrow, inlineLink, pageTitle } from "@/components/ui/styles";
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
    <main className={`${containerNarrow} py-14 sm:py-20`}>
      <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Contact" }]} />
      <p className={`mt-8 ${eyebrow}`}>Project contact</p>
      <h1 className={`mt-3 ${pageTitle}`}>Contact</h1>
      <p className={`mt-4 ${bodyText}`}>
        The starter currently uses draft operator facts. Replace the address below with the reviewed
        production support channel before launch.
      </p>
      <p className="mt-6">
        <a href={`mailto:${legalConfig.operator.supportEmail}`} className={inlineLink}>
          {legalConfig.operator.supportEmail}
        </a>
      </p>
    </main>
  );
}
