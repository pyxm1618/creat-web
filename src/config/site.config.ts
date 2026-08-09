import type { ProductConfig } from "@/platform/config/types";

export const siteConfig = {
  slug: "creat-web-sample",
  name: "Creat Web Sample",
  canonicalOrigin: "https://example.com",
  defaultLocale: "en",
  supportedLocales: ["en"],
  localeLabels: { en: "English" },
  localePrefixStrategy: "as-needed",
} as const satisfies ProductConfig["site"];
