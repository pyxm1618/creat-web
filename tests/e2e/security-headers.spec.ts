import { expect, test } from "@playwright/test";

const requiredPublicHeaders = [
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "x-frame-options",
  "permissions-policy",
] as const;

test("marketing responses carry the configured security baseline", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  for (const header of requiredPublicHeaders) {
    expect(response.headers()[header], `missing ${header}`).toBeTruthy();
  }
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["content-security-policy"]).toContain("object-src 'none'");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");
});

test("sensitive responses are no-store and noindex even before authentication", async ({
  request,
}) => {
  for (const path of ["/checkout/return", "/account", "/api/commerce/checkout"] as const) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.headers()["cache-control"], path).toContain("no-store");
    expect(response.headers()["x-robots-tag"], path).toBe("noindex, nofollow");
    expect(response.headers()["content-security-policy"], path).toContain(
      "frame-ancestors 'none'",
    );
  }
});

test("magic-link confirmation never leaks its URL through referrers", async ({ request }) => {
  const response = await request.get("/auth/magic-link/confirm", { maxRedirects: 0 });
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");
});
