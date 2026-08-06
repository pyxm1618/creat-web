import { describe, expect, it } from "vitest";

import { loadRuntimeEnv } from "@/platform/config/load-runtime-config";
import type { ProductConfig } from "@/platform/config/types";

const disabledFeatures = {
  auth: { enabled: false, google: false, magicLink: false, password: false },
  email: { enabled: false },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { ga4: false, clarity: false, consentRequired: true },
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

  it("uses the test email transport for magic link without Resend credentials", () => {
    const env = loadRuntimeEnv(
      {
        APP_ENV: "test",
        APP_ORIGIN: "http://localhost:3000",
        DATABASE_URL: "postgres://test:test@localhost:5432/test",
      },
      {
        ...disabledFeatures,
        auth: { ...disabledFeatures.auth, enabled: true, magicLink: true },
        email: { enabled: true },
      },
    );

    expect(env.emailTransport).toBe("test");
    expect(env.resendApiKey).toBeUndefined();
  });

  it("requires Resend credentials for production magic link", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          APP_ENV: "production",
          APP_ORIGIN: "https://example.com",
          DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
        },
        {
          ...disabledFeatures,
          auth: { ...disabledFeatures.auth, enabled: true, magicLink: true },
          email: { enabled: true },
        },
      ),
    ).toThrow("Resend credentials are required");
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
