import { expect, test } from "@playwright/test";

test("neutral runtime does not initialize disabled auth or commerce providers", async ({ request }) => {
  const account = await request.get("/account", { maxRedirects: 0 });
  expect(account.status()).toBeLessThan(500);

  const auth = await request.get("/api/auth/get-session", { maxRedirects: 0 });
  expect(auth.status()).toBe(404);

  const magicLink = await request.post("/api/auth/magic-link/request", {
    headers: {
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    },
    data: { email: "neutral@example.test", returnTo: "/account" },
  });
  expect(magicLink.status()).toBe(404);

  const checkout = await request.post("/api/commerce/checkout", {
    headers: {
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
      "idempotency-key": "neutral-runtime-checkout-key",
    },
    data: { productKey: "disabled-product" },
  });
  expect(checkout.status()).toBe(404);
});
