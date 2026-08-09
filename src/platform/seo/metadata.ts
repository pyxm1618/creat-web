import type { Metadata } from "next";

import type { AppEnvironment } from "@/platform/config/load-runtime-config";
import { buildLanguageAlternates, localePath } from "@/platform/i18n/routing";

import { canonicalUrl } from "./canonical";
import { seoEnvironmentPolicy } from "./environment-policy";
import type { IndexablePage, RouteRegistry } from "./types";

export type LocalizedSeoCopy = Pick<
  IndexablePage,
  "searchIntent" | "primaryKeyword" | "secondaryKeywords" | "title" | "description" | "h1"
>;

function indexableMetadata(
  registry: RouteRegistry,
  definition: IndexablePage,
  mode: AppEnvironment,
  locale: string,
  copy: LocalizedSeoCopy,
): Metadata {
  const policy = seoEnvironmentPolicy(mode);
  const canonicalRoute = definition.canonical ?? definition.route;
  const localizedCanonical = canonicalUrl(
    registry.site.canonicalOrigin,
    localePath(registry.site, locale, canonicalRoute),
  );
  const image = definition.image ?? registry.site.defaultOgImage;
  const languages = buildLanguageAlternates(
    registry.site,
    registry.site.canonicalOrigin,
    canonicalRoute,
  );

  return {
    title: copy.title,
    description: copy.description,
    alternates: policy.emitCanonical
      ? { canonical: localizedCanonical, languages }
      : undefined,
    robots: {
      index: policy.index,
      follow: policy.follow,
    },
    openGraph: {
      type: "website",
      title: copy.title,
      description: copy.description,
      url: policy.emitCanonical ? localizedCanonical : undefined,
      siteName: registry.site.siteName,
      locale,
      images: [{ url: image }],
    },
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.description,
      images: [image],
    },
  };
}

export function metadataForRoute(
  registry: RouteRegistry,
  route: string,
  mode: AppEnvironment,
): Metadata {
  const definition = registry.get(route);
  const policy = seoEnvironmentPolicy(mode);

  if (definition.class !== "public_indexable") {
    const publicNoindex = definition.class === "public_noindex";
    return {
      title: definition.title,
      description: definition.description,
      robots: {
        index: false,
        follow: publicNoindex && policy.follow,
      },
    };
  }

  return indexableMetadata(
    registry,
    definition,
    mode,
    registry.site.defaultLocale,
    definition,
  );
}

export function metadataForLocalizedRoute(
  registry: RouteRegistry,
  route: string,
  locale: string,
  copy: LocalizedSeoCopy,
  mode: AppEnvironment,
): Metadata {
  const definition = registry.get(route);
  if (definition.class !== "public_indexable") {
    throw new Error(`localized metadata requires an indexable route: ${route}`);
  }
  if (!registry.site.supportedLocales.includes(locale)) {
    throw new Error(`unsupported localized metadata locale: ${locale}`);
  }
  return indexableMetadata(registry, definition, mode, locale, copy);
}
