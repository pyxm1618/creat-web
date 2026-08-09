import { describe, expect, it } from "vitest";

import { loadRuntimeEnv } from "@/platform/config/load-runtime-config";
import type { ProductConfig } from "@/platform/config/types";

const disabledFeatures = {
  auth: { enabled: false, google: false, magicLink: false, password: false },
  email: { enabled: false },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { enabled: false, ga4: false, clarity: false, consentRequired: true },
} as const satisfies ProductConfig["features"];

const baseProductionSource = {
  APP_ENV: "production",
  APP_ORIGIN: "https://example.com",
  DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
} as const;

describe("IndexNow runtime configuration", () => {
  it("keeps IndexNow disabled when INDEXNOW_KEY is absent", () => {
    const env = loadRuntimeEnv(
      {
        APP_ENV: "test",
        APP_ORIGIN: "http://localhost:3000",
        DATABASE_URL: "postgres://test:test@localhost:5432/test",
      },
      disabledFeatures,
    );

    expect(env.indexNowKey).toBeUndefined();
  });

  it.each(["short", "contains space", "bad_key_value", "replace-me"])(
    "rejects invalid IndexNow key %s",
    (indexNowKey) => {
      expect(() =>
        loadRuntimeEnv(
          {
            APP_ENV: "test",
            APP_ORIGIN: "http://localhost:3000",
            DATABASE_URL: "postgres://test:test@localhost:5432/test",
            INDEXNOW_KEY: indexNowKey,
          },
          disabledFeatures,
        ),
      ).toThrow(/IndexNow key/i);
    },
  );

  it("requires deployed internal authentication when IndexNow is enabled", () => {
    expect(() =>
      loadRuntimeEnv(
        {
          ...baseProductionSource,
          INDEXNOW_KEY: "IndexNow-Key-12345",
        },
        disabledFeatures,
      ),
    ).toThrow("Cron secret are required");
  });

  it("loads a valid IndexNow key with deployed internal authentication", () => {
    const env = loadRuntimeEnv(
      {
        ...baseProductionSource,
        INDEXNOW_KEY: "IndexNow-Key-12345",
        CRON_SECRET: "b".repeat(32),
      },
      disabledFeatures,
    );

    expect(env.indexNowKey).toBe("IndexNow-Key-12345");
    expect(env.cronSecret).toBe("b".repeat(32));
  });
});
