import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __cwv?: { cls: number; lcp: number };
  }
}

for (const route of ["/", "/seo-starter-checklist"] as const) {
  test(`${route} stays within starter performance budgets`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.addInitScript(() => {
      window.__cwv = { cls: 0, lcp: 0 };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
          if (!shift.hadRecentInput) window.__cwv!.cls += shift.value ?? 0;
        }
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries.at(-1);
        if (last) window.__cwv!.lcp = last.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });

    const response = await page.goto(route, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await page.waitForTimeout(250);

    const metrics = await page.evaluate(() => {
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const scripts = resources.filter((resource) => resource.initiatorType === "script");
      const images = resources.filter((resource) => resource.initiatorType === "img");
      return {
        cls: window.__cwv?.cls ?? 0,
        lcp: window.__cwv?.lcp ?? 0,
        scriptBytes: scripts.reduce((sum, item) => sum + item.encodedBodySize, 0),
        scriptCount: scripts.length,
        oversizedImages: images
          .filter((image) => image.encodedBodySize > 500_000)
          .map((image) => ({ name: image.name, bytes: image.encodedBodySize })),
      };
    });

    expect(consoleErrors).toEqual([]);
    expect(metrics.cls).toBeLessThanOrEqual(0.1);
    expect(metrics.lcp).toBeGreaterThan(0);
    expect(metrics.lcp).toBeLessThanOrEqual(2500);
    expect(metrics.scriptBytes).toBeLessThanOrEqual(350_000);
    expect(metrics.scriptCount).toBeLessThanOrEqual(20);
    expect(metrics.oversizedImages).toEqual([]);

    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  });
}
