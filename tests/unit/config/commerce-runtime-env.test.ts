import { expect, it } from "vitest";

import { loadRuntimeEnv } from "@/platform/config/load-runtime-config";
import type { ProductConfig } from "@/platform/config/types";

const commerceFeatures = {
  auth: { enabled: false, google: false, magicLink: false, password: false },
  email: { enabled: false },
  commerce: { enabled: true, oneTime: true, subscriptions: false, credits: false },
  analytics: { enabled: false, ga4: false, clarity: false, consentRequired: true },
} as const satisfies ProductConfig["features"];

const retentionKey = Buffer.alloc(32, 7).toString("base64");

const baseCommerceEnv = {
  APP_ORIGIN: "https://example.com",
  DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
  CRON_SECRET: "c".repeat(32),
  WAFFO_MERCHANT_ID: "MER_test",
  WAFFO_PRIVATE_KEY: "private-test-key",
  WAFFO_STORE_ID: "STO_test",
  WAFFO_WEBHOOK_TEST_PUBLIC_KEY: "test-public-key",
  COMMERCE_RETENTION_KEY: retentionKey,
  COMMERCE_RETENTION_KEY_ID: "commerce-key-2026-08",
} as const;

it("requires complete commerce provider and retention configuration", () => {
  expect(() =>
    loadRuntimeEnv(
      { APP_ENV: "test", ...baseCommerceEnv, WAFFO_STORE_ID: undefined },
      commerceFeatures,
    ),
  ).toThrow("Waffo store configuration are required");

  expect(() =>
    loadRuntimeEnv(
      { APP_ENV: "test", ...baseCommerceEnv, COMMERCE_RETENTION_KEY: "bad" },
      commerceFeatures,
    ),
  ).toThrow("exactly 32 bytes");
});

it("permits local/test commerce without claiming live contract verification", () => {
  const env = loadRuntimeEnv({ APP_ENV: "test", ...baseCommerceEnv }, commerceFeatures);
  expect(env.waffoContractVerified).toBe(false);
  expect(env.waffoMerchantId).toBe("MER_test");
});

it("blocks deployed commerce until contract and production webhook key are explicit", () => {
  expect(() =>
    loadRuntimeEnv(
      {
        APP_ENV: "staging",
        VERCEL_ENV: "preview",
        ...baseCommerceEnv,
      },
      commerceFeatures,
    ),
  ).toThrow("Waffo contract must be verified");

  expect(() =>
    loadRuntimeEnv(
      {
        APP_ENV: "production",
        VERCEL_ENV: "production",
        ...baseCommerceEnv,
        WAFFO_CONTRACT_VERIFIED: "1",
      },
      commerceFeatures,
    ),
  ).toThrow("Waffo production webhook public key are required");

  const env = loadRuntimeEnv(
    {
      APP_ENV: "production",
      VERCEL_ENV: "production",
      ...baseCommerceEnv,
      WAFFO_WEBHOOK_PROD_PUBLIC_KEY: "prod-public-key",
      WAFFO_CONTRACT_VERIFIED: "1",
    },
    commerceFeatures,
  );
  expect(env.waffoContractVerified).toBe(true);
});
