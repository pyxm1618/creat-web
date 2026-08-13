import { expect, test } from "@playwright/test";

import { routeRegistry } from "@/config/routes.config";
import { localePath } from "@/platform/i18n/routing";

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function countPhrase(words: readonly string[], phrase: string): number {
  const wanted = tokenize(phrase);
  if (wanted.length === 0 || wanted.length > words.length) return 0;
  let count = 0;
  for (let index = 0; index <= words.length - wanted.length; index += 1) {
    if (wanted.every((word, offset) => words[index + offset] === word)) count += 1;
  }
  return count;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

test("production rendered SEO matches the route registry", async ({ page }) => {
  const sitemapEntries = new Map(
    routeRegistry.sitemapEntries().map((entry) => [entry.route, entry.canonical] as const),
  );

  for (const route of routeRegistry.indexable()) {
    const response = await page.goto(route.route, { waitUntil: "networkidle" });
    expect(response?.status(), `${route.route}: HTTP status`).toBe(200);

    const canonical = sitemapEntries.get(route.route);
    expect(canonical, `${route.route}: sitemap canonical exists`).toBeTruthy();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical!);

    const robots = (await page.locator('meta[name="robots"]').getAttribute("content")) ?? "";
    expect(robots.toLocaleLowerCase("en-US"), `${route.route}: must remain indexable`).not.toContain(
      "noindex",
    );

    await expect(page).toHaveTitle(route.title);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      route.description,
    );

    const h1 = page.locator("h1");
    await expect(h1, `${route.route}: exactly one H1`).toHaveCount(1);
    await expect(h1).toHaveText(route.h1);

    const headings = await page.locator("h1,h2,h3,h4,h5,h6").allTextContents();
    expect(
      headings.every((heading) => heading.trim().length > 0),
      `${route.route}: headings must not be empty UI placeholders`,
    ).toBe(true);

    const schemas = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(schemas.length, `${route.route}: structured data exists`).toBeGreaterThan(0);
    for (const schema of schemas) expect(() => JSON.parse(schema)).not.toThrow();

    const visibleText = await page.locator("body").innerText();
    const visibleWords = tokenize(visibleText);
    const keywordWords = [...new Set(tokenize(route.primaryKeyword))];
    const visibleWordSet = new Set(visibleWords);
    const coveredKeywordWords = keywordWords.filter((word) => visibleWordSet.has(word));
    const coverage = keywordWords.length === 0 ? 0 : coveredKeywordWords.length / keywordWords.length;
    const exactOccurrences = countPhrase(visibleWords, route.primaryKeyword);
    const densityPct = Number(
      ((exactOccurrences / Math.max(visibleWords.length, 1)) * 100).toFixed(3),
    );

    console.log(
      JSON.stringify({
        event: "rendered_seo_topic_audit",
        route: route.route,
        primaryKeyword: route.primaryKeyword,
        visibleWords: visibleWords.length,
        exactOccurrences,
        densityPct,
        tokenCoverage: coverage,
      }),
    );
    expect(coverage, `${route.route}: primary keyword tokens must be present in visible content`).toBe(1);

    const renderedInternalPaths = new Set(
      await page.locator('a[href^="/"]').evaluateAll((links) =>
        links.flatMap((link) => {
          const href = link.getAttribute("href");
          if (!href) return [];
          return [new URL(href, location.origin).pathname];
        }),
      ),
    );
    for (const relatedRoute of route.relatedRoutes) {
      const related = routeRegistry.get(relatedRoute);
      if (related.class !== "public_indexable") continue;
      expect(
        renderedInternalPaths.has(related.route),
        `${route.route}: declared indexable related route must be rendered: ${related.route}`,
      ).toBe(true);
    }

    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(response?.headers()["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  }
});

test("production sitemap is exactly the registered localized indexable surface", async ({ request }) => {
  const response = await request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
  const xml = await response.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => decodeXml(match[1]!))
    .sort();
  const origin = routeRegistry.site.canonicalOrigin.replace(/\/+$/, "");
  const expected = routeRegistry
    .sitemapEntries()
    .flatMap((entry) =>
      routeRegistry.site.supportedLocales.map(
        (locale) => `${origin}${localePath(routeRegistry.site, locale, entry.route)}`,
      ),
    )
    .sort();
  expect(locs).toEqual(expected);
});

test("production legal surfaces remain noindex and outside the sitemap", async ({ page, request }) => {
  const sitemap = await (await request.get("/sitemap.xml")).text();
  const legalNoindexRoutes = routeRegistry.routes.filter(
    (route) => route.class === "public_noindex" && route.pageType === "Legal",
  );

  for (const route of legalNoindexRoutes) {
    const response = await page.goto(route.route, { waitUntil: "networkidle" });
    expect(response?.status(), `${route.route}: HTTP status`).toBe(200);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/i);
    expect(sitemap, `${route.route}: must not enter sitemap`).not.toContain(
      `${routeRegistry.site.canonicalOrigin}${route.route}`,
    );
  }
});
