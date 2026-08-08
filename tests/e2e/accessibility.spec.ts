import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const route of ["/", "/pricing", "/privacy"] as const) {
  test(`${route} has no serious or critical automated accessibility violations`, async ({ page }) => {
    await page.goto(route);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(blocking).toEqual([]);
  });
}

test("keyboard reaches primary navigation, CTA and footer", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAttribute("href", "/");

  let reachedPricing = false;
  let reachedFooter = false;
  for (let index = 0; index < 30; index += 1) {
    const focused = page.locator(":focus");
    const href = await focused.getAttribute("href").catch(() => null);
    if (href === "/pricing") reachedPricing = true;
    if (href === "/privacy") reachedFooter = true;
    if (reachedPricing && reachedFooter) break;
    await page.keyboard.press("Tab");
  }

  expect(reachedPricing).toBe(true);
  expect(reachedFooter).toBe(true);
});

test("unknown route returns a real 404", async ({ page }) => {
  const response = await page.goto("/definitely-not-a-real-route");
  expect(response?.status()).toBe(404);
});
