import { z } from "zod";

import { canonicalUrl } from "./canonical";
import type {
  IndexablePage,
  RouteDefinition,
  RouteRegistry,
  SiteSeoConfig,
  SitemapRoute,
} from "./types";

const PLACEHOLDER_PATTERN = /\b(todo|tbd|placeholder|replace[ -]?me|lorem ipsum)\b/i;
const MIN_TITLE_LENGTH = 12;
const MAX_TITLE_LENGTH = 65;
const MIN_DESCRIPTION_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 180;

const siteSchema = z.object({
  siteName: z.string().trim().min(1),
  canonicalOrigin: z.url(),
  defaultLocale: z.string().trim().min(2),
  supportedLocales: z.array(z.string().trim().min(2)).min(1),
  localeLabels: z.record(z.string(), z.string().trim().min(1)),
  localePrefixStrategy: z.literal("as-needed"),
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
  title: z.string().trim().min(MIN_TITLE_LENGTH).max(MAX_TITLE_LENGTH),
  description: z.string().trim().min(MIN_DESCRIPTION_LENGTH).max(MAX_DESCRIPTION_LENGTH),
  h1: z.string().trim().min(3).max(120),
  canonical: z.string().optional(),
  image: z.string().startsWith("/").optional(),
  pageType: z.enum(["WebSite", "WebApplication", "SoftwareApplication", "Article", "Pricing"]),
  relatedRoutes: z.array(z.string().startsWith("/")),
  lastModified: z.iso.date(),
  reviewStatus: z.enum(["draft", "reviewed"]).optional(),
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

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function asIndexable(route: RouteDefinition): route is IndexablePage {
  return route.class === "public_indexable";
}

function meaningfulTokens(value: string): readonly string[] {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length >= 3);
}

function assertIntentAlignment(route: IndexablePage): void {
  const keywordTokens = new Set(meaningfulTokens(route.primaryKeyword));
  const combinedTokens = new Set(
    meaningfulTokens(`${route.searchIntent} ${route.title} ${route.h1} ${route.description}`),
  );
  if (![...keywordTokens].some((token) => combinedTokens.has(token))) {
    throw new Error(`SEO intent mismatch: ${route.route}`);
  }
}

function assertNoPlaceholders(route: IndexablePage): void {
  const fields = [
    route.searchIntent,
    route.primaryKeyword,
    route.title,
    route.description,
    route.h1,
  ];
  if (fields.some((field) => PLACEHOLDER_PATTERN.test(field))) {
    throw new Error(`placeholder SEO content: ${route.route}`);
  }
}

function assertReachableIndexableRoutes(
  routes: readonly IndexablePage[],
  routeMap: ReadonlyMap<string, RouteDefinition>,
): void {
  if (!routeMap.has("/")) return;
  const indexableRoutes = new Set(routes.map((route) => route.route));
  const visited = new Set<string>(["/"]);
  const queue = ["/"];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const definition = routeMap.get(current);
    if (!definition || !asIndexable(definition)) continue;
    for (const related of definition.relatedRoutes) {
      const target = normalizeRoute(related);
      if (!indexableRoutes.has(target) || visited.has(target)) continue;
      visited.add(target);
      queue.push(target);
    }
  }

  for (const route of routes) {
    if (route.route !== "/" && !visited.has(route.route)) {
      throw new Error(`orphan indexable route: ${route.route}`);
    }
  }
}

export function createRouteRegistry(
  siteInput: SiteSeoConfig,
  routeInputs: readonly RouteDefinition[],
): RouteRegistry {
  const site = siteSchema.parse(siteInput) as SiteSeoConfig;
  if (!site.supportedLocales.includes(site.defaultLocale)) {
    throw new Error("default SEO locale must be supported");
  }

  const routes = routeInputs.map((input) => {
    const parsed = routeSchema.parse({ ...input, route: normalizeRoute(input.route) });
    return parsed as RouteDefinition;
  });

  const routeMap = new Map<string, RouteDefinition>();
  const canonicals = new Map<string, string>();
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();
  const intents = new Map<string, string>();
  const keywords = new Map<string, string>();

  for (const route of routes) {
    if (routeMap.has(route.route)) throw new Error(`duplicate route: ${route.route}`);
    routeMap.set(route.route, route);

    if (!asIndexable(route)) continue;
    assertNoPlaceholders(route);
    assertIntentAlignment(route);

    const canonical = canonicalUrl(site.canonicalOrigin, route.canonical ?? route.route);
    const existingCanonical = canonicals.get(canonical);
    if (existingCanonical) {
      throw new Error(`duplicate canonical: ${canonical} (${existingCanonical}, ${route.route})`);
    }
    canonicals.set(canonical, route.route);

    const normalizedTitle = normalizeText(route.title);
    const existingTitle = titles.get(normalizedTitle);
    if (existingTitle) {
      throw new Error(`duplicate title: ${route.title} (${existingTitle}, ${route.route})`);
    }
    titles.set(normalizedTitle, route.route);

    const normalizedDescription = normalizeText(route.description);
    const existingDescription = descriptions.get(normalizedDescription);
    if (existingDescription) {
      throw new Error(
        `duplicate description: ${route.description} (${existingDescription}, ${route.route})`,
      );
    }
    descriptions.set(normalizedDescription, route.route);

    const normalizedIntent = normalizeText(route.searchIntent);
    const existingIntent = intents.get(normalizedIntent);
    if (existingIntent) {
      throw new Error(`intent conflict: ${existingIntent} and ${route.route}`);
    }
    intents.set(normalizedIntent, route.route);

    const normalizedKeyword = normalizeText(route.primaryKeyword);
    const existingKeyword = keywords.get(normalizedKeyword);
    if (existingKeyword) {
      throw new Error(`intent conflict: ${existingKeyword} and ${route.route}`);
    }
    keywords.set(normalizedKeyword, route.route);
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

  assertReachableIndexableRoutes(routes.filter(asIndexable), routeMap);

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
