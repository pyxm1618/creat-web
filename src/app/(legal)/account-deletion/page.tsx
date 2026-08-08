import type { Metadata } from "next";

import { LegalDocument } from "@/components/legal/legal-document";
import { legalConfig } from "@/config/legal.config";
import { routeRegistry } from "@/config/routes.config";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForRoute } from "@/platform/seo/metadata";

export const metadata: Metadata = metadataForRoute(
  routeRegistry,
  "/account-deletion",
  currentSeoEnvironment(),
);

export default function AccountDeletionInfoPage() {
  return (
    <LegalDocument
      title="Account Deletion"
      document={legalConfig.documents.account_deletion}
      sections={legalConfig.content.account_deletion}
    />
  );
}
