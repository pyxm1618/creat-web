import { describe, expect, it } from "vitest";

import { assertAllowedRelativeCallback } from "@/platform/auth/callback-url";
import { normalizeEmail } from "@/platform/auth/email-normalization";
import { buildMagicLinkConfirmationUrl } from "@/platform/auth/magic-link-confirmation";

describe("magic-link confirmation", () => {
  it("normalizes email deterministically", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("allows only exact approved relative callbacks", () => {
    expect(assertAllowedRelativeCallback("/account")).toBe("/account");
    expect(assertAllowedRelativeCallback("/account/security?tab=sessions")).toBe(
      "/account/security?tab=sessions",
    );
    expect(() => assertAllowedRelativeCallback("https://evil.example/steal")).toThrow(
      "untrusted callback",
    );
    expect(() => assertAllowedRelativeCallback("//evil.example/steal")).toThrow(
      "untrusted callback",
    );
    expect(() => assertAllowedRelativeCallback("/account\\evil")).toThrow("untrusted callback");
  });

  it("keeps token and callback in the URL fragment, not the HTTP request URL", () => {
    const value = buildMagicLinkConfirmationUrl({
      appOrigin: "https://app.example",
      token: "a".repeat(64),
      returnTo: "/account",
    });
    const url = new URL(value);

    expect(url.origin + url.pathname).toBe("https://app.example/auth/magic-link/confirm");
    expect(url.search).toBe("");
    expect(url.hash).toContain("token=");
    expect(url.hash).toContain("returnTo=%2Faccount");
    expect(value).not.toContain("/api/auth/magic-link/verify");
    expect(value).not.toContain("/magic-link/verify");
  });
});
