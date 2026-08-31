import type { ProductConfig } from "@/platform/config/types";

export const siteConfig = {
  slug: "focus-planner-test-only",
  name: "Focus Planner Test Utility",
  canonicalOrigin: "https://focus-planner.example",
  defaultLocale: "en",
  supportedLocales: ["en"],
  localeLabels: { en: "English" },
  localePrefixStrategy: "as-needed",
} as const satisfies ProductConfig["site"];
