import { expect, it } from "vitest";

import { createRouteRegistry } from "@/platform/seo/route-registry";
import { metadataForRoute } from "@/platform/seo/metadata";
import type { RouteDefinition, SiteSeoConfig } from "@/platform/seo/types";

const site: SiteSeoConfig = {
  siteName: "Example",
  canonicalOrigin: "https://example.com",
  defaultLocale: "en",
  supportedLocales: ["en"],
  localeLabels: { en: "English" },
  localePrefixStrategy: "as-needed",
  defaultTitle: "Example",
  titleTemplate: "%s | Example",
  defaultDescription: "A sufficiently detailed default description for the example site.",
  defaultOgImage: "/og/default.svg",
  releaseStatus: "reviewed",
};

const routes: RouteDefinition[] = [
  {
    route: "/",
    class: "public_indexable",
    searchIntent: "use example",
    primaryKeyword: "example tool",
    title: "Example Home",
    description: "A sufficiently detailed description for the example homepage metadata.",
    h1: "Example Home",
    pageType: "WebApplication",
    relatedRoutes: ["/pricing"],
    lastModified: "2026-08-08",
  },
  {
    route: "/pricing",
    class: "public_indexable",
    searchIntent: "compare example pricing",
    primaryKeyword: "example pricing",
    title: "Example Pricing",
    description: "A sufficiently detailed description for the example pricing metadata.",
    h1: "Example Pricing",
    pageType: "Pricing",
    relatedRoutes: ["/"],
    lastModified: "2026-08-08",
  },
  { route: "/privacy", class: "public_noindex", pageType: "Legal", title: "Privacy" },
  { route: "/account", class: "private" },
];

const registry = createRouteRegistry(site, routes);

it("emits canonical and language alternates only in production", () => {
  expect(metadataForRoute(registry, "/", "production").alternates).toEqual({
    canonical: "https://example.com/",
    languages: {
      en: "https://example.com/",
      "x-default": "https://example.com/",
    },
  });
  expect(metadataForRoute(registry, "/", "staging").alternates).toBeUndefined();
});

it("does not emit obsolete meta keywords", () => {
  expect(metadataForRoute(registry, "/", "production").keywords).toBeUndefined();
});

it("keeps legal pages noindex and follow only when environment allows following", () => {
  expect(metadataForRoute(registry, "/privacy", "production").robots).toMatchObject({
    index: false,
    follow: true,
  });
  expect(metadataForRoute(registry, "/privacy", "staging").robots).toMatchObject({
    index: false,
    follow: false,
  });
});

it("makes private routes noindex nofollow", () => {
  expect(metadataForRoute(registry, "/account", "production").robots).toMatchObject({
    index: false,
    follow: false,
  });
});
