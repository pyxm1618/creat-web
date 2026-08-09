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
    secondaryKeywords: ["online example tool"],
    title: "Example Tool for a Clear, Fast Online Workflow",
    description:
      "Use the example tool to complete the example workflow quickly, understand each step, and continue to the right supporting guide.",
    h1: "Example Tool for a Clear Online Workflow",
    pageType: "WebApplication",
    relatedRoutes: ["/guide"],
    lastModified: "2026-08-06",
    reviewStatus: "reviewed",
  } as RouteDefinition,
  {
    route: "/guide",
    class: "public_indexable",
    searchIntent: "learn the example workflow",
    primaryKeyword: "example workflow guide",
    secondaryKeywords: ["example workflow steps"],
    title: "Example Workflow Guide with Practical Steps",
    description:
      "Learn the example workflow with a practical guide, clear steps, and links back to the tool when you are ready to put the process into practice.",
    h1: "Example Workflow Guide with Practical Steps",
    pageType: "Article",
    relatedRoutes: ["/"],
    lastModified: "2026-08-06",
    reviewStatus: "reviewed",
  } as RouteDefinition,
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
          title: "Different Guide for Another Search Need",
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

  it("rejects placeholder production SEO copy", () => {
    expect(() =>
      createRouteRegistry(site, [
        {
          ...routes[0]!,
          title: "TODO replace me with a title",
        } as RouteDefinition,
        routes[1]!,
      ]),
    ).toThrow("placeholder");
  });

  it("rejects duplicate descriptions across indexable pages", () => {
    const home = routes[0] as Extract<RouteDefinition, { class: "public_indexable" }>;
    expect(() =>
      createRouteRegistry(site, [
        routes[0]!,
        {
          ...routes[1]!,
          description: home.description,
        } as RouteDefinition,
      ]),
    ).toThrow("duplicate description");
  });

  it("rejects an indexable orphan that is not the homepage", () => {
    expect(() =>
      createRouteRegistry(site, [
        { ...routes[0]!, relatedRoutes: [] } as RouteDefinition,
        { ...routes[1]!, relatedRoutes: [] } as RouteDefinition,
      ]),
    ).toThrow("orphan");
  });

  it("rejects obvious intent cannibalization", () => {
    expect(() =>
      createRouteRegistry(site, [
        routes[0]!,
        routes[1]!,
        {
          ...routes[1]!,
          route: "/guide-copy",
          title: "Another Example Workflow Guide for Practical Steps",
          description:
            "Learn the same example workflow with practical steps and use the tool once the process is clear enough to apply.",
          h1: "Another Example Workflow Guide",
          relatedRoutes: ["/"],
        } as RouteDefinition,
      ]),
    ).toThrow("intent conflict");
  });
});
