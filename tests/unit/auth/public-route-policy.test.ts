import { describe, expect, it } from "vitest";

import { isBlockedPublicAuthRequest } from "@/platform/auth/public-route-policy";

describe("public Better Auth route policy", () => {
  it("blocks native account mutation endpoints from public POST requests", () => {
    expect(
      isBlockedPublicAuthRequest(
        new Request("https://app.example/api/auth/delete-user", { method: "POST" }),
      ),
    ).toBe(true);
    expect(
      isBlockedPublicAuthRequest(
        new Request("https://app.example/api/auth/sign-in/magic-link", { method: "POST" }),
      ),
    ).toBe(true);
  });

  it("preserves public callback GET requests", () => {
    expect(
      isBlockedPublicAuthRequest(
        new Request("https://app.example/api/auth/callback/google", { method: "GET" }),
      ),
    ).toBe(false);
  });
});
