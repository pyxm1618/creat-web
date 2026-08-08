import type { LegalSectionContent } from "@/platform/legal/types";

export function LegalSection({ section }: Readonly<{ section: LegalSectionContent }>) {
  return (
    <section className="legal-section">
      <h2>{section.heading}</h2>
      {section.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </section>
  );
}
