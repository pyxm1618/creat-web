import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LandingPage } from "@/components/landing/landing-page";
import { JsonLd } from "@/components/seo/json-ld";
import { seoLandingForRoute, seoLandingPages } from "@/config/seo-landings.config";
import { routeRegistry } from "@/config/routes.config";
import { currentSeoEnvironment } from "@/platform/seo/environment-policy";
import { metadataForRoute } from "@/platform/seo/metadata";
import { articleJsonLd, webApplicationJsonLd } from "@/platform/seo/structured-data";

type SeoLandingPageProps = {
  readonly params: Promise<{ readonly slug: string }>;
};

function routeForSlug(slug: string): string {
  return `/${slug}`;
}

export function generateStaticParams() {
  return seoLandingPages.map((page) => ({ slug: page.route.replace(/^\//, "") }));
}

export async function generateMetadata({ params }: SeoLandingPageProps): Promise<Metadata> {
  const { slug } = await params;
  const route = routeForSlug(slug);
  if (!seoLandingForRoute(route)) notFound();
  return metadataForRoute(routeRegistry, route, currentSeoEnvironment());
}

export default async function SeoLandingPage({ params }: SeoLandingPageProps) {
  const { slug } = await params;
  const route = routeForSlug(slug);
  const landing = seoLandingForRoute(route);
  if (!landing) notFound();

  const definition = routeRegistry.get(route);
  if (definition.class !== "public_indexable") notFound();

  const url = `${routeRegistry.site.canonicalOrigin}${route}`;
  const structuredData =
    definition.pageType === "Article"
      ? articleJsonLd({
          headline: definition.h1,
          url,
          dateModified: definition.lastModified,
        })
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
