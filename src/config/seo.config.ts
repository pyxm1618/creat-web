import { siteConfig } from "@/config/site.config";
import type { SiteSeoConfig } from "@/platform/seo/types";

export const seoConfig = {
  siteName: siteConfig.name,
  canonicalOrigin: siteConfig.canonicalOrigin,
  defaultLocale: siteConfig.defaultLocale,
  supportedLocales: siteConfig.supportedLocales,
  localeLabels: siteConfig.localeLabels,
  localePrefixStrategy: siteConfig.localePrefixStrategy,
  defaultTitle: "Creat Web Sample",
  titleTemplate: "%s | Creat Web Sample",
  defaultDescription:
    "A neutral SEO-first starter for launching useful web products quickly with optional platform capabilities that remain disabled until needed.",
  defaultOgImage: "/og/default.png",
  releaseStatus: "draft",
} as const satisfies SiteSeoConfig;
