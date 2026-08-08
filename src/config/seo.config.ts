import { siteConfig } from "@/config/site.config";
import type { SiteSeoConfig } from "@/platform/seo/types";

export const seoConfig = {
  siteName: siteConfig.name,
  canonicalOrigin: siteConfig.canonicalOrigin,
  defaultLocale: siteConfig.defaultLocale,
  defaultTitle: "Creat Web Sample",
  titleTemplate: "%s | Creat Web Sample",
  defaultDescription:
    "A neutral starter for building secure, SEO-aware web products with reusable platform foundations.",
  defaultOgImage: "/og/default.png",
  releaseStatus: "draft",
} as const satisfies SiteSeoConfig;
