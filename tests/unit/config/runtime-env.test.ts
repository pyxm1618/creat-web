import { describe, expect, it } from "vitest";

import { loadRuntimeEnv } from "@/platform/config/load-runtime-config";
import type { ProductConfig } from "@/platform/config/types";

const disabledFeatures = {
  auth: { enabled: false, google: false, magicLink: false, password: false },
  email: { enabled: false },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { enabled: false, ga4: false, clarity: false, consentRequired: true },
} as const satisfies ProductConfig["features"];

const authFeatures = {
  ...disabledFeatures,
  auth: { ...disabledFeatures.auth, enabled: true, magicLink: true },
  email: { enabled: true },
} as const satisfies ProductConfig["features"];

const productionAuthSource = {
  APP_ENV: "production",
  APP_ORIGIN: "https://example.com",
  DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
  BETTER_AUTH_SECRET: "a".repeat(48),
  CRON_SECRET: "b".repeat(32),
  RESEND_API_KEY: "re_test_not_a_live_key",
  EMAIL_FROM: "Example <login@example.com>",
  SUPPORT_EMAIL: "support@example.com",
} as const;

describe("loadRuntimeEnv", () => {
  it("loads test mode without optional provider secrets", () => {
    const env = loadRuntimeEnv(
      {
        APP_ENV: "test",
        APP_ORIGIN: "http://localhost:3000",
        DATABASE_URL: "postgres://test:test@localhost:5432/test",
      },
      disabledFeatures,
    );
    expect(env.appEnv).toBe("test");
    expect(env.googleClientId).toBeUndefined();
    expect(env.waffoPrivateKey).toBeUndefined();
    expect(env.ga4MeasurementId).toBeUndefined();
    expect(env.clarityProjectId).toBeUndefined();
    expect(env.turnstileSiteKey).toBeUndefined();
    expect(env.turnstileSecretKey).toBeUndefined();
  });

  it("uses test-only auth, cron, email, and Turnstile configuration outside deployments", () => {
    const env = loadRuntimeEnv(
      {
        APP_ENV: "test",
        APP_ORIGIN: "http://localhost:3000",
        DATABASE_URL: "postgres://test:test@localhost:5432/test",
      },
      authFeatures,
    );
    expect(env.emailTransport).toBe("test");
    expect(env.betterAuthSecret).toMatch(/^test-only-/);
    expect(env.cronSecret).toMatch(/^test-only-/);
    expect(env.resendApiKey).toBeUndefined();
    expect(env.emailFrom).toBe("test@localhost.invalid");
    expect(env.turnstileSiteKey).toBe("1x00000000000000000000AA");
    expect(env.turnstileSecretKey).toBe("1x0000000000000000000000000000000AA");
  });

  it("rejects test mode on every Vercel deployment", () => {
    for (const vercelEnv of ["development", "preview", "production"] as const) {
      expect(() =>
        loadRuntimeEnv(
          {
            APP_ENV: "test",
            VERCEL_ENV: vercelEnv,
            APP_ORIGIN: "https://example.com",
            DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
          },
          authFeatures,
        ),
      ).toThrow(/VERCEL_ENV=.* requires APP_ENV=/);
    }
  });

  it("requires the Vercel deployment target and APP_ENV to agree", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "staging",
          VERCEL_ENV: "production",
          APP_ORIGIN: "https://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
          BETTER_AUTH_SECRET: "a".repeat(48),
          CRON_SECRET: "b".repeat(32),
          RESEND_API_KEY: "re_test_not_a_live_key",
          EMAIL_FROM: "Example <login@example.com>",
          SUPPORT_EMAIL: "support@example.com",
        },
        authFeatures,
      ),
    ).toThrow("VERCEL_ENV=production requires APP_ENV=production");
  });

  it("requires production authentication, cron, and email secrets", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          APP_ORIGIN: "https://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
        },
        authFeatures,
      ),
    ).toThrow("Better Auth secret is required");

    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          APP_ORIGIN: "https://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
          BETTER_AUTH_SECRET: "a".repeat(48),
        },
        authFeatures,
      ),
    ).toThrow("Cron secret are required");

    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          APP_ORIGIN: "https://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
          BETTER_AUTH_SECRET: "a".repeat(48),
          CRON_SECRET: "b".repeat(32),
        },
        authFeatures,
      ),
    ).toThrow("Resend credentials are required");
  });

  it("requires production Turnstile keys when Magic Link is enabled", () => {
    expect(() => loadRuntimeEnv(productionAuthSource, authFeatures)).toThrow(
      "Turnstile site key are required",
    );

    expect(() =>
      loadRuntimeEnv(
        { ...productionAuthSource, TURNSTILE_SITE_KEY: "0x4AAAA-real-site-key" },
        authFeatures,
      ),
    ).toThrow("Turnstile secret key are required");
  });

  it("rejects Cloudflare test Turnstile keys in staging and production", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          ...productionAuthSource,
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
        },
        authFeatures,
      ),
    ).toThrow(/Turnstile test keys are forbidden/i);
  });

  it("loads complete production auth configuration", () => {
    const env = loadRuntimeEnv(
      {
        ...productionAuthSource,
        VERCEL_ENV: "production",
        TURNSTILE_SITE_KEY: "0x4AAAA-real-site-key",
        TURNSTILE_SECRET_KEY: "0x4AAAA-real-secret-key",
      },
      authFeatures,
    );
    expect(env.emailTransport).toBe("resend");
    expect(env.emailFrom).toBe("Example <login@example.com>");
    expect(env.supportEmail).toBe("support@example.com");
    expect(env.vercelEnv).toBe("production");
    expect(env.turnstileSiteKey).toBe("0x4AAAA-real-site-key");
    expect(env.turnstileSecretKey).toBe("0x4AAAA-real-secret-key");
  });

  it("forbids test mailbox configuration outside local and test", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          ...productionAuthSource,
          TEST_EMAIL_DIR: "/tmp/should-never-exist",
        },
        authFeatures,
      ),
    ).toThrow("TEST_EMAIL_DIR is forbidden");
  });

  it("requires HTTPS origin in staging and production", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          APP_ORIGIN: "http://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
        },
        disabledFeatures,
      ),
    ).toThrow("APP_ORIGIN must use HTTPS");
  });

  it("requires Google credentials only when Google is enabled", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          APP_ORIGIN: "https://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
          BETTER_AUTH_SECRET: "a".repeat(48),
          CRON_SECRET: "b".repeat(32),
        },
        {
          ...disabledFeatures,
          auth: { ...disabledFeatures.auth, enabled: true, google: true },
        },
      ),
    ).toThrow("Google credentials are required");
  });

  it("requires analytics IDs only for enabled providers", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          APP_ORIGIN: "https://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
        },
        {
          ...disabledFeatures,
          analytics: { enabled: true, ga4: true, clarity: false, consentRequired: true },
        },
      ),
    ).toThrow("GA4 configuration are required");

    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          APP_ORIGIN: "https://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
        },
        {
          ...disabledFeatures,
          analytics: { enabled: true, ga4: false, clarity: true, consentRequired: true },
        },
      ),
    ).toThrow("Clarity configuration are required");
  });

  it("rejects production placeholder secrets", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          APP_ORIGIN: "https://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
          BETTER_AUTH_SECRET: "replace-me",
          CRON_SECRET: "b".repeat(32),
          GOOGLE_CLIENT_ID: "replace-me",
          GOOGLE_CLIENT_SECRET: "replace-me",
        },
        {
          ...disabledFeatures,
          auth: { ...disabledFeatures.auth, enabled: true, google: true },
        },
      ),
    ).toThrow("placeholder secret");
  });
});
