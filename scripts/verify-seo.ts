import "./verify-indexnow";

import type { LandingSection } from "@/components/landing/landing-page";
import { homeConfig } from "@/config/home.config";
import { routeRegistry } from "@/config/routes.config";
import { seoConfig } from "@/config/seo.config";
import { seoLandingPages } from "@/config/seo-landings.config";

const indexable = routeRegistry.indexable();
const sitemap = routeRegistry.sitemapEntries();
const GENERIC_ANCHOR = /^(click here|here|read more|learn more|more|link)$/i;
const PLACEHOLDER = /\b(todo|tbd|placeholder|replace[ -]?me|lorem ipsum)\b/i;

if (indexable.length === 0) throw new Error("at least one indexable route is required");
if (sitemap.length !== indexable.length) throw new Error("sitemap/indexable route mismatch");

const contentByRoute = new Map<string, readonly LandingSection[]>([
  ["/", homeConfig.sections],
  ...seoLandingPages.map((page) => [page.route, page.sections] as const),
]);

function internalLinks(sections: readonly LandingSection[]) {
  const links: { label: string; href: string }[] = [];
  for (const section of sections.filter((item) => item.enabled !== false)) {
    switch (section.type) {
      case "hero":
        links.push(section.primaryCta);
        if (section.secondaryCta) links.push(section.secondaryCta);
        break;
      case "use-cases":
        for (const item of section.items) {
          if (item.href) links.push({ label: item.title, href: item.href });
        }
        break;
      case "related-resources":
        links.push(...section.links.map(({ label, href }) => ({ label, href })));
        break;
      case "final-cta":
        links.push(section.cta);
        break;
      default:
        break;
    }
  }
  return links;
}

const inbound = new Set<string>();
for (const route of indexable) {
  if (!route.primaryKeyword.trim() || !route.searchIntent.trim() || !route.h1.trim()) {
    throw new Error(`indexable route is incomplete: ${route.route}`);
  }
  if (PLACEHOLDER.test(`${route.title} ${route.description} ${route.h1}`)) {
    throw new Error(`placeholder SEO copy: ${route.route}`);
  }
  if (Number.isNaN(Date.parse(`${route.lastModified}T00:00:00Z`))) {
    throw new Error(`invalid lastModified: ${route.route}`);
  }
  const sitemapEntry = sitemap.find((entry) => entry.route === route.route);
  if (!sitemapEntry) throw new Error(`missing sitemap entry: ${route.route}`);
  if (new URL(sitemapEntry.canonical).origin !== new URL(seoConfig.canonicalOrigin).origin) {
    throw new Error(`invalid canonical: ${route.route}`);
  }
  const depth = route.route === "/" ? 0 : route.route.split("/").filter(Boolean).length;
  if (depth > 3) throw new Error(`indexable route is unnecessarily deep: ${route.route}`);

  const sections = contentByRoute.get(route.route);
  if (!sections) throw new Error(`missing landing content for indexable route: ${route.route}`);
  const heroes = sections.filter((section) => section.enabled !== false && section.type === "hero");
  if (heroes.length !== 1) {
    throw new Error(`indexable route must render exactly one primary hero/H1: ${route.route}`);
  }
  const hero = heroes[0]! as Extract<LandingSection, { type: "hero" }>;
  if (hero.h1.trim() !== route.h1.trim()) throw new Error(`route/H1 content drift: ${route.route}`);

  for (const link of internalLinks(sections)) {
    if (GENERIC_ANCHOR.test(link.label.trim())) {
      throw new Error(`generic internal anchor: ${route.route} -> ${link.href}`);
    }
    if (!link.href.startsWith("/") || link.href.startsWith("//")) continue;
    const target = link.href.split(/[?#]/)[0] || "/";
    let targetRoute;
    try {
      targetRoute = routeRegistry.get(target);
    } catch {
      throw new Error(`broken internal link: ${route.route} -> ${target}`);
    }
    if (targetRoute.class === "public_indexable") inbound.add(target);
  }
}

for (const route of indexable) {
  if (route.route !== "/" && !inbound.has(route.route)) {
    throw new Error(`orphan indexable route in rendered content: ${route.route}`);
  }
}

for (const entry of sitemap) {
  const route = routeRegistry.get(entry.route);
  if (route.class !== "public_indexable") {
    throw new Error(`non-indexable route entered sitemap: ${entry.route}`);
  }
}

const home = routeRegistry.get("/");
if (home.class !== "public_indexable") throw new Error("homepage must be public indexable");
if (home.title.length < 20 || home.title.length > 65) {
  throw new Error("homepage title fails strict TDH gate");
}
if (home.description.length < 100 || home.description.length > 180) {
  throw new Error("homepage description fails strict TDH gate");
}
if (home.h1.length < 20) throw new Error("homepage H1 is too weak for strict TDH gate");

if (process.env.APP_ENV === "production") {
  const releaseStatus: string = seoConfig.releaseStatus;
  if (releaseStatus !== "reviewed") {
    throw new Error("production SEO config must be reviewed");
  }
  if (/example\.com/i.test(seoConfig.canonicalOrigin)) {
    throw new Error("production SEO canonical origin is a placeholder");
  }
  for (const route of indexable) {
    if (route.reviewStatus !== "reviewed") {
      throw new Error(`production SEO route must be reviewed: ${route.route}`);
    }
  }
}

console.log(
  JSON.stringify({
    event: "seo_verified",
    indexableRoutes: indexable.length,
    sitemapEntries: sitemap.length,
    releaseStatus: seoConfig.releaseStatus,
    indexNowGate: "verified",
  }),
);
