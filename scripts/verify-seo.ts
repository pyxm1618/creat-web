import { routeRegistry } from "@/config/routes.config";
import { seoConfig } from "@/config/seo.config";
import { validateLinkGraph } from "@/platform/seo/link-graph";

const indexable = routeRegistry.indexable();
const sitemap = routeRegistry.sitemapEntries();

if (indexable.length === 0) throw new Error("at least one indexable route is required");
if (sitemap.length !== indexable.length) throw new Error("sitemap/indexable route mismatch");

const seenDescriptions = new Set<string>();
for (const route of indexable) {
  if (!route.primaryKeyword.trim() || !route.searchIntent.trim() || !route.h1.trim()) {
    throw new Error(`indexable route is incomplete: ${route.route}`);
  }
  if (seenDescriptions.has(route.description)) {
    throw new Error(`duplicate description: ${route.route}`);
  }
  seenDescriptions.add(route.description);
  if (Number.isNaN(Date.parse(`${route.lastModified}T00:00:00Z`))) {
    throw new Error(`invalid lastModified: ${route.route}`);
  }
  const sitemapEntry = sitemap.find((entry) => entry.route === route.route);
  if (!sitemapEntry) throw new Error(`missing sitemap entry: ${route.route}`);
  if (new URL(sitemapEntry.canonical).origin !== new URL(seoConfig.canonicalOrigin).origin) {
    throw new Error(`invalid canonical: ${route.route}`);
  }
}

for (const entry of sitemap) {
  const route = routeRegistry.get(entry.route);
  if (route.class !== "public_indexable") {
    throw new Error(`non-indexable route entered sitemap: ${entry.route}`);
  }
}

const links = [
  { from: "/", to: "/pricing" },
  { from: "/", to: "/privacy" },
  { from: "/", to: "/terms" },
  { from: "/pricing", to: "/" },
  { from: "/pricing", to: "/refund-policy" },
  { from: "/pricing", to: "/terms" },
] as const;
const graph = validateLinkGraph(
  indexable.map((route) => route.route),
  links,
);
if (graph.broken.length || graph.orphans.length) {
  throw new Error(`invalid link graph: ${JSON.stringify(graph)}`);
}

const isReviewed = (status: string): boolean => status === "reviewed";
if (process.env.APP_ENV === "production" && !isReviewed(seoConfig.releaseStatus)) {
  throw new Error("production SEO config must be reviewed");
}
if (process.env.APP_ENV === "production" && /example\.com/i.test(seoConfig.canonicalOrigin)) {
  throw new Error("production SEO canonical origin is a placeholder");
}

console.log(
  JSON.stringify({
    event: "seo_verified",
    indexableRoutes: indexable.length,
    sitemapEntries: sitemap.length,
    releaseStatus: seoConfig.releaseStatus,
  }),
);
