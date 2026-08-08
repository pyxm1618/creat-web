import type { Metadata } from "next";

import { LegalDocument } from "@/components/legal/legal-document";
import { legalConfig } from "@/config/legal.config";
import { routeRegistry } from "@/config/routes.config";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForRoute } from "@/platform/seo/metadata";

export const metadata: Metadata = metadataForRoute(
  routeRegistry,
  "/acceptable-use",
  currentSeoEnvironment(),
);

export default function AcceptableUsePage() {
  return (
    <LegalDocument
      title="Acceptable Use Policy"
      document={legalConfig.documents.acceptable_use}
      sections={legalConfig.content.acceptable_use}
    />
  );
}
