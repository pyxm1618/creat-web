import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LandingPage } from "@/components/landing/landing-page";
import { JsonLd } from "@/components/seo/json-ld";
import { localeBundle } from "@/config/locales.config";
import { routeRegistry } from "@/config/routes.config";
import { seoLandingPages } from "@/config/seo-landings.config";
import { siteConfig } from "@/config/site.config";
import { localizeLandingSections } from "@/platform/i18n/landing-sections";
import { isSupportedLocale, localePath } from "@/platform/i18n/routing";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForLocalizedRoute } from "@/platform/seo/metadata";
import { articleJsonLd, webApplicationJsonLd } from "@/platform/seo/structured-data";

type LocalizedLandingProps = {
  readonly params: Promise<{ readonly segment: string; readonly slug: string }>;
};

function localizedRoute(segment: string, slug: string) {
  if (segment === siteConfig.defaultLocale || !isSupportedLocale(siteConfig, segment)) {
    return undefined;
  }
  const route = `/${slug}`;
  const configured = seoLandingPages.some((page) => page.route === route);
  return configured ? { locale: segment, route } : undefined;
}

export function generateStaticParams() {
  return siteConfig.supportedLocales
    .filter((locale) => locale !== siteConfig.defaultLocale)
    .flatMap((segment) =>
      seoLandingPages.map((page) => ({
        segment,
        slug: page.route.replace(/^\//, ""),
      })),
    );
}

export async function generateMetadata({ params }: LocalizedLandingProps): Promise<Metadata> {
  const { segment, slug } = await params;
  const target = localizedRoute(segment, slug);
  if (!target) notFound();
  const bundle = localeBundle(target.locale);
  const copy = bundle?.seo[target.route];
  if (!bundle || !copy || !bundle.landingSections[target.route]) notFound();
  return metadataForLocalizedRoute(
    routeRegistry,
    target.route,
    target.locale,
    copy,
    currentSeoEnvironment(),
  );
}

export default async function LocalizedLandingPage({ params }: LocalizedLandingProps) {
  const { segment, slug } = await params;
  const target = localizedRoute(segment, slug);
  if (!target) notFound();
  const bundle = localeBundle(target.locale);
  const copy = bundle?.seo[target.route];
  const configuredSections = bundle?.landingSections[target.route];
  if (!bundle || !copy || !configuredSections) notFound();

  const definition = routeRegistry.get(target.route);
  if (definition.class !== "public_indexable") notFound();
  const sections = localizeLandingSections(
    configuredSections,
    siteConfig,
    target.locale,
    new Set(Object.keys(bundle.seo)),
  );
  const url = `${routeRegistry.site.canonicalOrigin}${localePath(siteConfig, target.locale, target.route)}`;
  const structuredData =
    definition.pageType === "Article"
      ? articleJsonLd({ headline: copy.h1, url, dateModified: definition.lastModified })
      : webApplicationJsonLd({ name: copy.title, url, description: copy.description });

  return (
    <main>
      <JsonLd value={structuredData} />
      <LandingPage sections={sections} />
    </main>
  );
}
