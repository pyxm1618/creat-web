import { expect, test } from "@playwright/test";

function extractConfirmationUrl(html: string): string {
  const match = html.match(/href="([^"]+)"/);
  if (!match?.[1]) throw new Error("confirmation link missing from test email");
  return match[1].replaceAll("&amp;", "&");
}

test("mail scanners cannot consume a token and explicit confirmation signs in exactly once", async ({
  page,
  request,
}) => {
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

  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  const sendResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/magic-link/request") &&
      response.request().method() === "POST",
    { timeout: 15_000 },
  );
  await page.getByRole("button", { name: "Send secure sign-in link" }).click();
  const sendResponse = await sendResponsePromise;
  expect(sendResponse.status(), await sendResponse.text()).toBe(202);
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
  expect(externalRequests).toEqual([]);
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

test("magic link sending is bounded per normalized email", async ({ request }) => {
  const email = `limited-${Date.now()}@example.com`;
  for (let index = 0; index < 3; index += 1) {
    const response = await request.post("/api/auth/magic-link/request", {
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
        "x-real-ip": `203.0.113.${30 + index}`,
      },
      data: { email: index % 2 === 0 ? email.toUpperCase() : email, returnTo: "/account" },
    });
    expect(response.status()).toBe(202);
  }

  const limited = await request.post("/api/auth/magic-link/request", {
    headers: {
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
      "x-real-ip": "203.0.113.99",
    },
    data: { email, returnTo: "/account" },
  });
  expect(limited.status()).toBe(429);
});

test("protected account pages redirect unauthenticated users", async ({ page }) => {
  await page.goto("/account/security");
  await expect(page).toHaveURL(/\/sign-in$/);
});
