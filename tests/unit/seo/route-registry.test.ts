import { describe, expect, it } from "vitest";

import { createRouteRegistry } from "@/platform/seo/route-registry";
import type { RouteDefinition, SiteSeoConfig } from "@/platform/seo/types";

const site: SiteSeoConfig = {
  siteName: "Example Tool",
  canonicalOrigin: "https://example.com",
  defaultLocale: "en",
  defaultTitle: "Example Tool",
  titleTemplate: "%s | Example Tool",
  defaultDescription: "A precise description of the example tool for testing purposes.",
  defaultOgImage: "/og/default.png",
  releaseStatus: "draft",
};

const routes: RouteDefinition[] = [
  {
    route: "/",
    class: "public_indexable",
    searchIntent: "use the example tool",
    primaryKeyword: "example tool",
    title: "Example Tool",
    description: "Use the example tool and understand how the example workflow works.",
    h1: "Example Tool",
    pageType: "WebApplication",
    relatedRoutes: ["/guide"],
    lastModified: "2026-08-06",
  },
  {
    route: "/guide",
    class: "public_indexable",
    searchIntent: "learn the example workflow",
    primaryKeyword: "example guide",
    title: "Example Guide",
    description: "Learn the example workflow with a concise guide and clear next steps.",
    h1: "Example Guide",
    pageType: "Article",
    relatedRoutes: ["/"],
    lastModified: "2026-08-06",
  },
  { route: "/account", class: "private" },
];

describe("route registry", () => {
  it("returns only public indexable routes for sitemap", () => {
    const registry = createRouteRegistry(site, routes);
    expect(registry.sitemapEntries().map((entry) => entry.route)).toEqual(["/", "/guide"]);
  });

  it("rejects duplicate canonicals", () => {
    expect(() =>
      createRouteRegistry(site, [
        ...routes,
        {
          ...routes[1]!,
          route: "/duplicate",
          title: "Different Title",
          canonical: "/guide",
        } as RouteDefinition,
      ]),
    ).toThrow("duplicate canonical");
  });

  it("rejects indexable routes without required intent fields", () => {
    expect(() =>
      createRouteRegistry(site, [{ route: "/thin", class: "public_indexable" } as RouteDefinition]),
    ).toThrow();
  });

  it("rejects related routes that are not registered", () => {
    expect(() =>
      createRouteRegistry(site, [
        {
          ...routes[0]!,
          relatedRoutes: ["/missing"],
        } as RouteDefinition,
      ]),
    ).toThrow("unknown related route");
  });
});
