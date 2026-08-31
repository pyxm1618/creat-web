import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/navigation/site-footer";
import { SiteHeader } from "@/components/navigation/site-header";
import { siteConfig } from "@/config/site.config";
import { rootMetadata } from "@/platform/seo/root-metadata";

import "../globals.css";

export const metadata: Metadata = rootMetadata();

export default async function LegalLayout({ children }: Readonly<{ children: ReactNode }>) {
  await connection();
  return (
    <html lang={siteConfig.defaultLocale}>
      <body>
        <div className="flex min-h-screen flex-col">
          <SiteHeader />
          {children}
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
