import { routeRegistry } from "@/config/routes.config";
import { buildLanguageAlternates, localePath } from "@/platform/i18n/routing";
import { currentSeoEnvironment, seoEnvironmentPolicy } from "@/platform/seo/environment-policy";

export const dynamic = "force-dynamic";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(): Promise<Response> {
  const policy = seoEnvironmentPolicy(currentSeoEnvironment());
  if (!policy.emitSitemap) {
    return new Response("Not Found", {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  const origin = routeRegistry.site.canonicalOrigin.replace(/\/+$/, "");
  const urls = routeRegistry
    .sitemapEntries()
    .flatMap((entry) => {
      const alternates = buildLanguageAlternates(
        routeRegistry.site,
        routeRegistry.site.canonicalOrigin,
        entry.route,
      );
      const alternateXml = Object.entries(alternates)
        .map(
          ([language, href]) =>
            `<xhtml:link rel="alternate" hreflang="${escapeXml(language)}" href="${escapeXml(href)}"/>`,
        )
        .join("");

      return routeRegistry.site.supportedLocales.map((locale) => {
        const loc = `${origin}${localePath(routeRegistry.site, locale, entry.route)}`;
        return `<url><loc>${escapeXml(loc)}</loc><lastmod>${escapeXml(entry.lastModified)}</lastmod>${alternateXml}</url>`;
      });
    })
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "cache-control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
      "content-type": "application/xml; charset=utf-8",
    },
  });
}
