import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LandingPage } from "@/components/landing/landing-page";
import { JsonLd } from "@/components/seo/json-ld";
import { localeBundle } from "@/config/locales.config";
import { routeRegistry } from "@/config/routes.config";
import { seoLandingForRoute } from "@/config/seo-landings.config";
import { siteConfig } from "@/config/site.config";
import { localizeLandingSections } from "@/platform/i18n/landing-sections";
import { localePath } from "@/platform/i18n/routing";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForLocalizedRoute, metadataForRoute } from "@/platform/seo/metadata";
import { articleJsonLd, webApplicationJsonLd, websiteJsonLd } from "@/platform/seo/structured-data";

type SegmentPageProps = {
  readonly params: Promise<{ readonly segment: string }>;
};

function nonDefaultLocale(segment: string): string | undefined {
  if (segment === siteConfig.defaultLocale) return undefined;
  return siteConfig.supportedLocales.includes(segment) ? segment : undefined;
}

export async function generateMetadata({ params }: SegmentPageProps): Promise<Metadata> {
  const { segment } = await params;
  const locale = nonDefaultLocale(segment);
  if (locale) {
    const bundle = localeBundle(locale);
    const copy = bundle?.seo["/"];
    if (!bundle || !copy) notFound();
    return metadataForLocalizedRoute(routeRegistry, "/", locale, copy, currentSeoEnvironment());
  }

  const route = `/${segment}`;
  if (!seoLandingForRoute(route)) notFound();
  return metadataForRoute(routeRegistry, route, currentSeoEnvironment());
}

export default async function SegmentPage({ params }: SegmentPageProps) {
  const { segment } = await params;
  const locale = nonDefaultLocale(segment);

  if (locale) {
    const bundle = localeBundle(locale);
    const copy = bundle?.seo["/"];
    if (!bundle || !copy) notFound();
    const localizedRoutes = new Set(Object.keys(bundle.seo));
    const sections = localizeLandingSections(
      bundle.homeSections,
      siteConfig,
      locale,
      localizedRoutes,
    );
    const url = `${routeRegistry.site.canonicalOrigin}${localePath(siteConfig, locale, "/")}`;
    return (
      <main>
        <JsonLd
          value={websiteJsonLd({
            name: routeRegistry.site.siteName,
            url,
            description: copy.description,
          })}
        />
        <JsonLd
          value={webApplicationJsonLd({
            name: copy.title,
            url,
            description: copy.description,
          })}
        />
        <LandingPage sections={sections} />
      </main>
    );
  }

  const route = `/${segment}`;
  const landing = seoLandingForRoute(route);
  if (!landing) notFound();
  const definition = routeRegistry.get(route);
  if (definition.class !== "public_indexable") notFound();
  const url = `${routeRegistry.site.canonicalOrigin}${route}`;
  const structuredData =
    definition.pageType === "Article"
      ? articleJsonLd({ headline: definition.h1, url, dateModified: definition.lastModified })
      : webApplicationJsonLd({
          name: definition.title,
          url,
          description: definition.description,
        });

  return (
    <main>
      <JsonLd value={structuredData} />
      <LandingPage sections={landing.sections} />
    </main>
  );
}
