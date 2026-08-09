import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "@/platform/security/content-security-policy";

describe("buildContentSecurityPolicy", () => {
  it("allows only nonce-authorized inline scripts without unsafe-inline", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "nonce-value",
      development: false,
      production: true,
      analytics: { ga4: false, clarity: false },
      turnstile: false,
    });

    const scriptDirective = csp.match(/(?:^|; )script-src ([^;]+)/)?.[1] ?? "";
    expect(scriptDirective).toContain("'self'");
    expect(scriptDirective).toContain("'nonce-nonce-value'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("admits only enabled third-party analytics and Turnstile origins", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "test-nonce",
      development: true,
      production: false,
      analytics: { ga4: true, clarity: true },
      turnstile: true,
    });

    expect(csp).toContain("https://www.googletagmanager.com");
    expect(csp).toContain("https://www.google-analytics.com");
    expect(csp).toContain("https://region1.google-analytics.com");
    expect(csp).toContain("https://www.clarity.ms");
    expect(csp).toContain("https://*.clarity.ms");
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});
