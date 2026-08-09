import { expect, test } from "@playwright/test";

const analyticsHosts = ["www.googletagmanager.com", "www.google-analytics.com", "region1.google-analytics.com", "www.clarity.ms"];

function isAnalytics(url: string): boolean {
  try {
    return analyticsHosts.some((host) => new URL(url).hostname === host || new URL(url).hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

test("analytics makes zero third-party requests before consent", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (isAnalytics(url)) {
      requests.push(url);
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.goto("/test/analytics-consent");
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: "Allow analytics" }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
});

test("sensitive sign-in surface does not load analytics", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (isAnalytics(request.url())) requests.push(request.url());
  });
  await page.goto("/sign-in");
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
});
