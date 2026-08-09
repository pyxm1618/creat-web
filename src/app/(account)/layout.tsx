import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { featuresConfig } from "@/config/features.config";
import { siteConfig } from "@/config/site.config";
import { rootMetadata } from "@/platform/seo/root-metadata";

import "../globals.css";

export const metadata: Metadata = {
  ...rootMetadata(),
  robots: { index: false, follow: false },
};

export default function AccountRootLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (!featuresConfig.auth.enabled) notFound();
  return (
    <html lang={siteConfig.defaultLocale}>
      <body>{children}</body>
    </html>
  );
}
