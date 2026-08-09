import { expect, test } from "@playwright/test";

const analyticsHosts = [
  "www.googletagmanager.com",
  "www.google-analytics.com",
  "region1.google-analytics.com",
  "www.clarity.ms",
];

const consentStorageKey = "creat-web:analytics-consent:v1";

function isAnalytics(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return analyticsHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
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
  await page.goto("/");
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);

  const consent = page.getByRole("complementary", { name: "Analytics consent" });
  await expect(consent).toBeVisible();
  await consent.getByRole("button", { name: "Allow analytics" }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
});

test("declining analytics persists and settings can be reopened", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (isAnalytics(request.url())) requests.push(request.url());
  });

  await page.goto("/");
  const consent = page.getByRole("complementary", { name: "Analytics consent" });
  await consent.getByRole("button", { name: "Decline" }).click();

  await expect(page.getByRole("button", { name: "Analytics settings" })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), consentStorageKey)).toBe("denied");

  await page.reload();
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
  await expect(page.getByRole("button", { name: "Analytics settings" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Analytics consent" })).toBeHidden();

  await page.getByRole("button", { name: "Analytics settings" }).click();
  await expect(page.getByRole("complementary", { name: "Analytics settings panel" })).toBeVisible();
});

test("granted analytics can be withdrawn and remains disabled after reload", async ({ page }) => {
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

  await page.goto("/");
  await page
    .getByRole("complementary", { name: "Analytics consent" })
    .getByRole("button", { name: "Allow analytics" })
    .click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Analytics settings" }).click();
  const settings = page.getByRole("complementary", { name: "Analytics settings panel" });
  await settings.getByRole("button", { name: "Withdraw analytics consent" }).click();

  expect(await page.evaluate((key) => localStorage.getItem(key), consentStorageKey)).toBe("denied");
  await expect(page.locator("#creat-web-ga4")).toHaveCount(0);
  await expect(page.locator("#creat-web-clarity")).toHaveCount(0);

  requests.length = 0;
  await page.reload();
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
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
