import { expect, test } from "@playwright/test";

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_TEST_TOKEN = "turnstile-script-regression-token";

test("Turnstile script remains compatible with ready()", async ({ page }) => {
  await page.route(TURNSTILE_SCRIPT_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        (() => {
          const script = document.currentScript;
          if (!(script instanceof HTMLScriptElement)) {
            throw new Error("Turnstile script element is unavailable");
          }
          if (script.async || script.defer) {
            throw new Error("Turnstile ready() is incompatible with async/defer script loading");
          }

          window.turnstile = {
            ready(callback) {
              callback();
            },
            render(_container, options) {
              queueMicrotask(() => options.callback(${JSON.stringify(TURNSTILE_TEST_TOKEN)}));
              return "turnstile-regression-widget";
            },
            reset() {},
            remove() {},
          };
        })();
      `,
    });
  });

  await page.goto("/sign-in");

  const script = page.locator("#creat-web-turnstile-script");
  await expect(script).toHaveCount(1);
  await expect
    .poll(() =>
      script.evaluate((element) => ({
        async: (element as HTMLScriptElement).async,
        defer: (element as HTMLScriptElement).defer,
      })),
    )
    .toEqual({ async: false, defer: false });

  await expect(page.getByRole("button", { name: "Send secure sign-in link" })).toBeEnabled({
    timeout: 15_000,
  });
});
