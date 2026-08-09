import { expect, test } from "@playwright/test";

import { routeRegistry } from "@/config/routes.config";

test("test environment is layered noindex with no production canonical or sitemap", async ({
  page,
  request,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");

  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/i);
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);

  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Disallow: /");

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(404);
});

test("structured data parses and matches registered homepage SEO facts", async ({ page }) => {
  const home = routeRegistry.get("/");
  if (home.class !== "public_indexable") throw new Error("homepage must be indexable");

  await page.goto("/");
  const scripts = page.locator('script[type="application/ld+json"]');
  expect(await scripts.count()).toBeGreaterThanOrEqual(2);
  const structuredData = [] as unknown[];
  for (const text of await scripts.allTextContents()) {
    const parsed = JSON.parse(text) as unknown;
    structuredData.push(parsed);
  }

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(home.h1);
  const serialized = JSON.stringify(structuredData);
  expect(serialized).toContain(home.title);
  expect(serialized).toContain(home.description);
});
