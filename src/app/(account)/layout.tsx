import type { Metadata } from "next";
import type { ReactNode } from "react";

import { siteConfig } from "@/config/site.config";
import { rootMetadata } from "@/platform/seo/root-metadata";

import "../globals.css";

export const metadata: Metadata = {
  ...rootMetadata(),
  robots: { index: false, follow: false },
};

export default function AccountRootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang={siteConfig.defaultLocale}>
      <body>{children}</body>
    </html>
  );
}
