import { expect, it } from "vitest";

import type { LandingSection } from "@/components/landing/landing-page";
import { localizeLandingSections } from "@/platform/i18n/landing-sections";

it("prefixes only translated indexable internal links", () => {
  const sections: readonly LandingSection[] = [
    {
      type: "hero",
      h1: "Localized heading",
      lead: "Body",
      primaryCta: { label: "Guide", href: "/guide" },
      secondaryCta: { label: "Privacy", href: "/privacy" },
    },
    {
      type: "related-resources",
      heading: "Related",
      links: [
        { label: "Home", href: "/" },
        { label: "External", href: "https://example.org" },
      ],
    },
  ];

  const localized = localizeLandingSections(
    sections,
    {
      defaultLocale: "en",
      supportedLocales: ["en", "de"],
      localeLabels: { en: "English", de: "Deutsch" },
      localePrefixStrategy: "as-needed",
    },
    "de",
    new Set(["/", "/guide"]),
  );

  expect((localized[0] as Extract<LandingSection, { type: "hero" }>).primaryCta.href).toBe(
    "/de/guide",
  );
  expect((localized[0] as Extract<LandingSection, { type: "hero" }>).secondaryCta?.href).toBe(
    "/privacy",
  );
  expect(
    (localized[1] as Extract<LandingSection, { type: "related-resources" }>).links[0]?.href,
  ).toBe("/de");
});
