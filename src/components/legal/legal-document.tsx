import { Breadcrumbs } from "@/components/navigation/breadcrumbs";
import type { LegalDocumentVersion, LegalSectionContent } from "@/platform/legal/types";

import { LegalSection } from "./legal-section";

export function LegalDocument({
  title,
  document,
  sections,
}: Readonly<{
  title: string;
  document: LegalDocumentVersion;
  sections: readonly LegalSectionContent[];
}>) {
  return (
    <main className="legal-page">
      <div className="content-width content-width--narrow">
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: title }]} />
        <p className="eyebrow">Policy document</p>
        <h1>{title}</h1>
        <p className="document-meta">
          Version {document.version} · Effective {document.effectiveDate} · {document.reviewStatus}
        </p>
        {sections.map((section) => (
          <LegalSection key={section.heading} section={section} />
        ))}
      </div>
    </main>
  );
}
