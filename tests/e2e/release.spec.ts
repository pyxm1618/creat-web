import { expect, test } from "@playwright/test";

test("public release surface renders from versioned config without hidden setup", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page).toHaveTitle(/.+/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/i);
});

test("sensitive surfaces remain noindex in browser output", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/i);
  await expect(page.getByRole("heading", { name: "Sign in securely" })).toBeVisible();
});
