import { describe, expect, it } from "vitest";

import { buildLanguageAlternates, localePath, localeFromPath } from "@/platform/i18n/routing";

const config = {
  defaultLocale: "en",
  supportedLocales: ["en", "de", "fr"] as const,
  localeLabels: { en: "English", de: "Deutsch", fr: "Français" },
  localePrefixStrategy: "as-needed" as const,
};

describe("locale routing", () => {
  it("keeps the default locale unprefixed and prefixes translated locales", () => {
    expect(localePath(config, "en", "/")).toBe("/");
    expect(localePath(config, "en", "/guide")).toBe("/guide");
    expect(localePath(config, "de", "/")).toBe("/de");
    expect(localePath(config, "fr", "/guide")).toBe("/fr/guide");
  });

  it("parses only supported locale prefixes", () => {
    expect(localeFromPath(config, "/de/guide")).toBe("de");
    expect(localeFromPath(config, "/guide")).toBe("en");
    expect(localeFromPath(config, "/zz/guide")).toBe("en");
  });

  it("emits self-referential hreflang alternatives and x-default", () => {
    expect(buildLanguageAlternates(config, "https://example.com", "/guide")).toEqual({
      en: "https://example.com/guide",
      de: "https://example.com/de/guide",
      fr: "https://example.com/fr/guide",
      "x-default": "https://example.com/guide",
    });
  });
});
