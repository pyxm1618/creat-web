import { z } from "zod";

import { canonicalUrl } from "./canonical";
import type {
  IndexablePage,
  RouteDefinition,
  RouteRegistry,
  SiteSeoConfig,
  SitemapRoute,
} from "./types";

const siteSchema = z.object({
  siteName: z.string().trim().min(1),
  canonicalOrigin: z.url(),
  defaultLocale: z.string().trim().min(2),
  defaultTitle: z.string().trim().min(1),
  titleTemplate: z.string().trim().min(1),
  defaultDescription: z.string().trim().min(20),
  defaultOgImage: z.string().startsWith("/"),
  releaseStatus: z.enum(["draft", "reviewed"]),
});

const indexableSchema = z.object({
  route: z.string().startsWith("/"),
  class: z.literal("public_indexable"),
  searchIntent: z.string().trim().min(3),
  primaryKeyword: z.string().trim().min(2),
  secondaryKeywords: z.array(z.string().trim().min(2)).optional(),
  title: z.string().trim().min(3),
  description: z.string().trim().min(20),
  h1: z.string().trim().min(3),
  canonical: z.string().optional(),
  image: z.string().startsWith("/").optional(),
  pageType: z.enum(["WebSite", "WebApplication", "SoftwareApplication", "Article", "Pricing"]),
  relatedRoutes: z.array(z.string().startsWith("/")).min(1),
  lastModified: z.iso.date(),
});

const nonIndexableSchema = z.object({
  route: z.string().startsWith("/"),
  class: z.enum(["public_noindex", "private", "system"]),
  pageType: z.literal("Legal").optional(),
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
});

const routeSchema = z.discriminatedUnion("class", [
  indexableSchema,
  z.object({ ...nonIndexableSchema.shape, class: z.literal("public_noindex") }),
  z.object({ ...nonIndexableSchema.shape, class: z.literal("private") }),
  z.object({ ...nonIndexableSchema.shape, class: z.literal("system") }),
]);

function normalizeRoute(route: string): string {
  if (route === "/") return "/";
  const stripped = route.split("?")[0]?.split("#")[0]?.replace(/\/+$/, "") ?? route;
  return stripped || "/";
}

function asIndexable(route: RouteDefinition): route is IndexablePage {
  return route.class === "public_indexable";
}

export function createRouteRegistry(
  siteInput: SiteSeoConfig,
  routeInputs: readonly RouteDefinition[],
): RouteRegistry {
  const site = siteSchema.parse(siteInput) as SiteSeoConfig;
  const routes = routeInputs.map((input) => {
    const parsed = routeSchema.parse({ ...input, route: normalizeRoute(input.route) });
    return parsed as RouteDefinition;
  });

  const routeMap = new Map<string, RouteDefinition>();
  const canonicals = new Map<string, string>();
  const titles = new Map<string, string>();

  for (const route of routes) {
    if (routeMap.has(route.route)) throw new Error(`duplicate route: ${route.route}`);
    routeMap.set(route.route, route);

    if (!asIndexable(route)) continue;
    const canonical = canonicalUrl(site.canonicalOrigin, route.canonical ?? route.route);
    const existingCanonical = canonicals.get(canonical);
    if (existingCanonical) {
      throw new Error(`duplicate canonical: ${canonical} (${existingCanonical}, ${route.route})`);
    }
    canonicals.set(canonical, route.route);

    const normalizedTitle = route.title.trim().toLocaleLowerCase("en-US");
    const existingTitle = titles.get(normalizedTitle);
    if (existingTitle) {
      throw new Error(`duplicate title: ${route.title} (${existingTitle}, ${route.route})`);
    }
    titles.set(normalizedTitle, route.route);
  }

  for (const route of routes.filter(asIndexable)) {
    for (const related of route.relatedRoutes) {
      const normalized = normalizeRoute(related);
      if (!routeMap.has(normalized)) {
        throw new Error(`unknown related route: ${route.route} -> ${normalized}`);
      }
      if (normalized === route.route) {
        throw new Error(`self-related route: ${route.route}`);
      }
    }
  }

  return {
    site,
    routes,
    get(route: string): RouteDefinition {
      const normalized = normalizeRoute(route);
      const definition = routeMap.get(normalized);
      if (!definition) throw new Error(`unregistered route: ${normalized}`);
      return definition;
    },
    indexable(): readonly IndexablePage[] {
      return routes.filter(asIndexable);
    },
    sitemapEntries(): readonly SitemapRoute[] {
      return routes.filter(asIndexable).map((route) => ({
        route: route.route,
        canonical: canonicalUrl(site.canonicalOrigin, route.canonical ?? route.route),
        lastModified: route.lastModified,
      }));
    },
  };
}
