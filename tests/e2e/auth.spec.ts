import { expect, test } from "@playwright/test";

function extractConfirmationUrl(html: string): string {
  const match = html.match(/href="([^"]+)"/);
  if (!match?.[1]) throw new Error("confirmation link missing from test email");
  return match[1].replaceAll("&amp;", "&");
}

test("mail scanner GET does not consume token and explicit confirmation signs in once", async ({
  page,
  request,
}) => {
  const email = `browser-${Date.now()}@example.com`;

  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send secure sign-in link" }).click();
  await expect(page.getByText(/a sign-in link has been sent/i)).toBeVisible();

  const mailbox = await request.get(`/api/test/emails/latest?to=${encodeURIComponent(email)}`);
  expect(mailbox.ok()).toBeTruthy();
  const message = (await mailbox.json()) as { html: string };
  const confirmationUrl = extractConfirmationUrl(message.html);
  const parsed = new URL(confirmationUrl);
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const token = fragment.get("token");
  const returnTo = fragment.get("returnTo") ?? "/account";
  expect(token).toBeTruthy();

  const scanner = await request.get(`${parsed.origin}${parsed.pathname}`);
  expect(scanner.ok()).toBeTruthy();

  await page.goto(confirmationUrl);
  await expect(page).toHaveURL(/\/auth\/magic-link\/confirm$/);
  await page.getByRole("button", { name: "Confirm sign in" }).click();
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

test("protected account pages redirect unauthenticated users", async ({ page }) => {
  await page.goto("/account/security");
  await expect(page).toHaveURL(/\/sign-in$/);
});
