import { describe, expect, it } from "vitest";

import { loadRuntimeEnv } from "@/platform/config/load-runtime-config";
import type { ProductConfig } from "@/platform/config/types";

const disabledFeatures = {
  auth: { enabled: false, google: false, magicLink: false, password: false },
  email: { enabled: false },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { ga4: false, clarity: false, consentRequired: true },
} as const satisfies ProductConfig["features"];

const authFeatures = {
  ...disabledFeatures,
  auth: { ...disabledFeatures.auth, enabled: true, magicLink: true },
  email: { enabled: true },
} as const satisfies ProductConfig["features"];

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
  });

  it("uses test-only auth, cron, and email configuration only outside deployments", () => {
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

    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          VERCEL_ENV: "preview",
          APP_ORIGIN: "https://preview.example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
          BETTER_AUTH_SECRET: "a".repeat(48),
          CRON_SECRET: "b".repeat(32),
          RESEND_API_KEY: "re_test_not_a_live_key",
          EMAIL_FROM: "Example <login@example.com>",
          SUPPORT_EMAIL: "support@example.com",
        },
        authFeatures,
      ),
    ).toThrow("VERCEL_ENV=preview requires APP_ENV=staging");
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

  it("loads complete production auth configuration", () => {
    const env = loadRuntimeEnv(
      {
        APP_ENV: "production",
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
    );

    expect(env.emailTransport).toBe("resend");
    expect(env.emailFrom).toBe("Example <login@example.com>");
    expect(env.supportEmail).toBe("support@example.com");
    expect(env.vercelEnv).toBe("production");
  });

  it("forbids test mailbox configuration outside local and test", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          APP_ORIGIN: "https://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
          BETTER_AUTH_SECRET: "a".repeat(48),
          CRON_SECRET: "b".repeat(32),
          RESEND_API_KEY: "re_test_not_a_live_key",
          EMAIL_FROM: "Example <login@example.com>",
          SUPPORT_EMAIL: "support@example.com",
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
