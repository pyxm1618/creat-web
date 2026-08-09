import { siteConfig } from "@/config/site.config";
import type { SiteSeoConfig } from "@/platform/seo/types";

export const seoConfig = {
  siteName: siteConfig.name,
  canonicalOrigin: siteConfig.canonicalOrigin,
  defaultLocale: siteConfig.defaultLocale,
  supportedLocales: siteConfig.supportedLocales,
  localeLabels: siteConfig.localeLabels,
  localePrefixStrategy: siteConfig.localePrefixStrategy,
  defaultTitle: "Focus Planner Test Utility",
  titleTemplate: "%s | Focus Planner Test Utility",
  defaultDescription:
    "A fictional test-only focus planning utility used to verify the reusable web product starter.",
  defaultOgImage: "/og/default.svg",
  releaseStatus: "draft",
} as const satisfies SiteSeoConfig;
