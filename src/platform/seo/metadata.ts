import type { Metadata } from "next";

import type { AppEnvironment } from "@/platform/config/load-runtime-config";

import { canonicalUrl } from "./canonical";
import { seoEnvironmentPolicy } from "./environment-policy";
import type { RouteRegistry } from "./types";

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

  const canonical = canonicalUrl(
    registry.site.canonicalOrigin,
    definition.canonical ?? definition.route,
  );
  const image = definition.image ?? registry.site.defaultOgImage;

  return {
    title: definition.title,
    description: definition.description,
    keywords: [definition.primaryKeyword, ...(definition.secondaryKeywords ?? [])],
    alternates: policy.emitCanonical ? { canonical } : undefined,
    robots: {
      index: policy.index,
      follow: policy.follow,
    },
    openGraph: {
      type: "website",
      title: definition.title,
      description: definition.description,
      url: policy.emitCanonical ? canonical : undefined,
      siteName: registry.site.siteName,
      locale: registry.site.defaultLocale,
      images: [{ url: image }],
    },
    twitter: {
      card: "summary_large_image",
      title: definition.title,
      description: definition.description,
      images: [image],
    },
  };
}
