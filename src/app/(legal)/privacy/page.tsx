import type { Metadata } from "next";

import { LegalDocument } from "@/components/legal/legal-document";
import { legalConfig } from "@/config/legal.config";
import { routeRegistry } from "@/config/routes.config";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForRoute } from "@/platform/seo/metadata";

export const metadata: Metadata = metadataForRoute(
  routeRegistry,
  "/privacy",
  currentSeoEnvironment(),
);

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Notice"
      document={legalConfig.documents.privacy}
      sections={legalConfig.content.privacy}
    />
  );
}
