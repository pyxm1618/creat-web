import { expect, test } from "@playwright/test";

const legalRoutes = [
  "/privacy",
  "/terms",
  "/acceptable-use",
  "/refund-policy",
  "/account-deletion",
] as const;

for (const route of legalRoutes) {
  test(`${route} is reachable, versioned and noindex`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByText(/Version draft-1/i)).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/i);
    await expect(page.getByRole("contentinfo")).toBeVisible();
  });
}

test("every legal route is linked from the footer", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("contentinfo");
  for (const route of [...legalRoutes, "/contact"] as const) {
    await expect(footer.locator(`a[href='${route}']`)).toHaveCount(1);
  }
});
