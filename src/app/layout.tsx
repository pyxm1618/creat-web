import type { Metadata } from "next";
import type { ReactNode } from "react";

import { seoConfig } from "@/config/seo.config";
import { currentSeoEnvironment, metadataOrigin } from "@/platform/seo/environment-policy";

import "./globals.css";

const mode = currentSeoEnvironment();
const appOrigin = process.env.APP_ORIGIN;

export const metadata: Metadata = {
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
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang={seoConfig.defaultLocale}>
      <body>{children}</body>
    </html>
  );
}
