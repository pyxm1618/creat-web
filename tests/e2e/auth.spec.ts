import { expect, test, type Page } from "@playwright/test";

const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

function extractConfirmationUrl(html: string): string {
  const match = html.match(/href="([^"]+)"/);
  if (!match?.[1]) throw new Error("confirmation link missing from test email");
  return match[1].replaceAll("&amp;", "&");
}

async function installBrowserTurnstileMock(page: Page): Promise<void> {
  await page.addInitScript((token) => {
    let nextWidgetId = 0;
    const turnstile = {
      ready(callback: () => void) {
        callback();
      },
      render(_container: HTMLElement, options: { callback: (value: string) => void }) {
        const widgetId = `test-widget-${++nextWidgetId}`;
        queueMicrotask(() => options.callback(token));
        return widgetId;
      },
      reset(widgetId?: string) {
        void widgetId;
      },
      remove(widgetId?: string) {
        void widgetId;
      },
    };
    (window as unknown as Window & { turnstile?: typeof turnstile }).turnstile = turnstile;
  }, TURNSTILE_TEST_TOKEN);
}

test("native Better Auth mutation endpoints are not public", async ({ request }) => {
  for (const path of ["/api/auth/delete-user", "/api/auth/sign-in/magic-link"]) {
    const response = await request.post(path, {
      headers: { "content-type": "application/json" },
    });
    expect(response.status()).toBe(404);
  }
});

test("magic link confirmation is scanner-safe and single-use", async ({ page, request }) => {
  const email = `browser-${Date.now()}@example.com`;
  const externalRequests: string[] = [];
  const getRequests: string[] = [];
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (browserRequest.method() === "GET") getRequests.push(browserRequest.url());
    if (!new Set(["127.0.0.1", "localhost"]).has(url.hostname)) {
      externalRequests.push(browserRequest.url());
    }
  });

  await installBrowserTurnstileMock(page);
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  const sendButton = page.getByRole("button", { name: "Send secure sign-in link" });
  await expect(sendButton).toBeEnabled({ timeout: 15_000 });
  const sendResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/magic-link/request") &&
      response.request().method() === "POST",
    { timeout: 15_000 },
  );
  await sendButton.click();
  const sendResponse = await sendResponsePromise;
  expect(sendResponse.status()).toBe(202);
  await expect(page.getByText(/a sign-in link has been sent/i)).toBeVisible();

  const mailbox = await request.get(`/api/test/emails/latest?to=${encodeURIComponent(email)}`);
  expect(mailbox.ok()).toBeTruthy();
  const message = (await mailbox.json()) as { html: string };
  const confirmationUrl = extractConfirmationUrl(message.html);
  expect(confirmationUrl).not.toContain("/magic-link/verify");
  const parsed = new URL(confirmationUrl);
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const token = fragment.get("token");
  const returnTo = fragment.get("returnTo") ?? "/account";
  expect(token).toBeTruthy();

  for (let index = 0; index < 3; index += 1) {
    const scanner = await request.get(`${parsed.origin}${parsed.pathname}`);
    expect(scanner.ok()).toBeTruthy();
  }

  const wrongOrigin = await request.post("/api/auth/magic-link/confirm", {
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json",
      "x-real-ip": "203.0.113.20",
    },
    data: { token, returnTo },
  });
  expect(wrongOrigin.status()).toBe(403);

  const wrongCallback = await request.post("/api/auth/magic-link/confirm", {
    headers: {
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
      "x-real-ip": "203.0.113.20",
    },
    data: { token, returnTo: "https://evil.example/steal" },
  });
  expect(wrongCallback.status()).toBe(400);

  await page.goto(confirmationUrl);
  await expect(page).toHaveURL(/\/auth\/magic-link\/confirm$/);
  expect(
    externalRequests.every((url) => new URL(url).hostname === "challenges.cloudflare.com"),
  ).toBeTruthy();
  expect(getRequests.some((url) => token && url.includes(token))).toBeFalsy();

  const verificationResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/magic-link/confirm") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Confirm sign in" }).click();
  const verificationResponse = await verificationResponsePromise;
  expect(verificationResponse.status()).toBeLessThan(400);
  expect((await verificationResponse.headerValue("set-cookie")) ?? "").toContain("session_token");
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

  const replay = await request.post("/api/auth/magic-link/confirm", {
    headers: {
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
      "x-real-ip": "203.0.113.20",
    },
    data: { token, returnTo },
  });
  expect(replay.ok()).toBeFalsy();
});

test("magic link requests fail closed without a Turnstile token", async ({ request }) => {
  const response = await request.post("/api/auth/magic-link/request", {
    headers: {
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
      "x-real-ip": "203.0.113.80",
    },
    data: {
      email: `missing-challenge-${Date.now()}@example.com`,
      returnTo: "/account",
    },
  });
  expect(response.status()).toBe(400);
});

test("magic link email rate limits follow a valid challenge", async ({ request }) => {
  const email = `limited-${Date.now()}@example.com`;
  for (let index = 0; index < 3; index += 1) {
    const response = await request.post("/api/auth/magic-link/request", {
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
        "x-real-ip": `203.0.113.${30 + index}`,
      },
      data: {
        email: index % 2 === 0 ? email.toUpperCase() : email,
        returnTo: "/account",
        turnstileToken: TURNSTILE_TEST_TOKEN,
      },
    });
    expect(response.status()).toBe(202);
  }

  const limited = await request.post("/api/auth/magic-link/request", {
    headers: {
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
      "x-real-ip": "203.0.113.99",
    },
    data: { email, returnTo: "/account", turnstileToken: TURNSTILE_TEST_TOKEN },
  });
  expect(limited.status()).toBe(429);
});

test("protected account pages redirect unauthenticated users", async ({ page }) => {
  await page.goto("/account/security");
  await expect(page).toHaveURL(/\/sign-in$/);
});
