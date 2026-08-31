import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __analyticsPerf?: { cls: number; inp: number; lcp: number };
    __gaStubLoaded?: boolean;
    __clarityStubLoaded?: boolean;
  }
}

test("analytics-enabled homepage stays within release budgets", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.route("https://www.googletagmanager.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "window.__gaStubLoaded=true;",
    });
  });
  await page.route("https://www.clarity.ms/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "window.__clarityStubLoaded=true;",
    });
  });

  await page.addInitScript(() => {
    localStorage.setItem("creat-web:analytics-consent:v1", "granted");
    window.__analyticsPerf = { cls: 0, inp: 0, lcp: 0 };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput) window.__analyticsPerf!.cls += shift.value ?? 0;
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries.at(-1);
      if (last) window.__analyticsPerf!.lcp = last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const interaction = entry as PerformanceEntry & {
          duration?: number;
          interactionId?: number;
        };
        if ((interaction.interactionId ?? 0) > 0) {
          window.__analyticsPerf!.inp = Math.max(
            window.__analyticsPerf!.inp,
            interaction.duration ?? 0,
          );
        }
      }
    }).observe({
      type: "event",
      buffered: true,
      durationThreshold: 16,
    } as PerformanceObserverInit & { durationThreshold: number });
  });

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-robots-tag"]).toContain("noindex");

  await page.waitForFunction(() => window.__gaStubLoaded === true);
  await page.waitForFunction(() => window.__clarityStubLoaded === true);
  await expect(page.getByRole("button", { name: "Analytics settings" })).toBeVisible();

  const firstLink = page.locator('a[href^="/"]').first();
  await firstLink.evaluate((element) => {
    element.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        const until = performance.now() + 20;
        while (performance.now() < until) {
          // Deliberately create a measurable lab interaction without navigation.
        }
      },
      { once: true },
    );
  });
  await firstLink.click();
  await page.waitForTimeout(100);

  const metrics = await page.evaluate(() => {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const scripts = resources.filter((resource) => resource.initiatorType === "script");
    const providerScripts = scripts.filter(
      (resource) =>
        resource.name.startsWith("https://www.googletagmanager.com/") ||
        resource.name.startsWith("https://www.clarity.ms/"),
    );
    return {
      cls: window.__analyticsPerf?.cls ?? 0,
      inp: window.__analyticsPerf?.inp ?? 0,
      lcp: window.__analyticsPerf?.lcp ?? 0,
      scriptBytes: scripts.reduce((sum, item) => sum + item.encodedBodySize, 0),
      scriptCount: scripts.length,
      providerScriptCount: providerScripts.length,
    };
  });

  expect(consoleErrors).toEqual([]);
  expect(metrics.providerScriptCount).toBe(2);
  expect(metrics.cls).toBeLessThanOrEqual(0.1);
  expect(metrics.lcp).toBeGreaterThan(0);
  expect(metrics.lcp).toBeLessThanOrEqual(2500);
  expect(metrics.inp).toBeGreaterThan(0);
  expect(metrics.inp).toBeLessThanOrEqual(200);
  expect(metrics.scriptBytes).toBeLessThanOrEqual(350_000);
  expect(metrics.scriptCount).toBeLessThanOrEqual(22);
});
