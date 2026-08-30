import type { LegalSectionContent } from "@/platform/legal/types";

export function LegalSection({ section }: Readonly<{ section: LegalSectionContent }>) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">{section.heading}</h2>
      <div className="mt-3 space-y-3">
        {section.paragraphs.map((paragraph) => (
          <p key={paragraph} className="text-[0.9375rem] leading-relaxed text-muted">
            {paragraph}
          </p>
        ))}
      </div>
    </section>
  );
}
