import { routeRegistry } from "@/config/routes.config";
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

  const urls = routeRegistry
    .sitemapEntries()
    .map(
      (entry) =>
        `<url><loc>${escapeXml(entry.canonical)}</loc><lastmod>${escapeXml(entry.lastModified)}</lastmod></url>`,
    )
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "cache-control": "public, max-age=0, s-maxage=3600",
      "content-type": "application/xml; charset=utf-8",
    },
  });
}
