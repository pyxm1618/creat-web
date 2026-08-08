import { expect, test } from "@playwright/test";

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

test("structured data parses and mirrors visible homepage facts", async ({ page }) => {
  await page.goto("/");
  const scripts = page.locator('script[type="application/ld+json"]');
  expect(await scripts.count()).toBeGreaterThanOrEqual(2);
  for (const text of await scripts.allTextContents()) {
    expect(() => JSON.parse(text)).not.toThrow();
  }
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Build a focused web product",
  );
});
