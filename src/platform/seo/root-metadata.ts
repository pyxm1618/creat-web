import type { Metadata } from "next";

import { seoConfig } from "@/config/seo.config";
import { currentSeoEnvironment, metadataOrigin } from "@/platform/seo/environment-policy";

export function rootMetadata(): Metadata {
  const mode = currentSeoEnvironment();
  const appOrigin = process.env.APP_ORIGIN;

  return {
    metadataBase: metadataOrigin({
      mode,
      ...(appOrigin ? { appOrigin } : {}),
      canonicalOrigin: seoConfig.canonicalOrigin,
    }),
    title: {
      default: seoConfig.defaultTitle,
      template: seoConfig.titleTemplate,
    },
    description: seoConfig.defaultDescription,
    icons: {
      icon: "/favicon.ico",
      apple: "/apple-touch-icon.png",
    },
    manifest: "/manifest.webmanifest",
  };
}
