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
    <main className="mx-auto w-full max-w-3xl px-6 py-14 sm:px-8 sm:py-20">
      <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: title }]} />
      <p className="mt-8 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
        Policy document
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance text-foreground sm:text-4xl">
        {title}
      </h1>
      <p className="mt-4 text-sm text-muted">
        Version {document.version} · Effective {document.effectiveDate} · {document.reviewStatus}
      </p>
      <div className="mt-4 border-t border-border" />
      {sections.map((section) => (
        <LegalSection key={section.heading} section={section} />
      ))}
    </main>
  );
}
