import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/navigation/site-footer";
import { SiteHeader } from "@/components/navigation/site-header";
import { seoLandingPages } from "@/config/seo-landings.config";
import { siteConfig } from "@/config/site.config";
import { rootMetadata } from "@/platform/seo/root-metadata";

import "../globals.css";

export const metadata: Metadata = rootMetadata();

type SegmentLayoutProps = {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly segment: string }>;
};

export function generateStaticParams() {
  const landingSegments = seoLandingPages.map((page) => page.route.replace(/^\//, ""));
  const localeSegments = siteConfig.supportedLocales.filter(
    (locale) => locale !== siteConfig.defaultLocale,
  );
  return [...new Set([...landingSegments, ...localeSegments])].map((segment) => ({ segment }));
}

export default async function SegmentRootLayout({ children, params }: SegmentLayoutProps) {
  const { segment } = await params;
  const locale =
    segment !== siteConfig.defaultLocale && siteConfig.supportedLocales.includes(segment)
      ? segment
      : siteConfig.defaultLocale;

  return (
    <html lang={locale}>
      <body>
        <div className="site-frame">
          <SiteHeader locale={locale} />
          {children}
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
