import type { Metadata } from "next";

import { LegalDocument } from "@/components/legal/legal-document";
import { legalConfig } from "@/config/legal.config";
import { routeRegistry } from "@/config/routes.config";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForRoute } from "@/platform/seo/metadata";

export const metadata: Metadata = metadataForRoute(
  routeRegistry,
  "/terms",
  currentSeoEnvironment(),
);

export default function TermsPage() {
  return (
    <LegalDocument
      title="Terms of Service"
      document={legalConfig.documents.terms}
      sections={legalConfig.content.terms}
    />
  );
}
