import { spawnSync } from "node:child_process";

import { loadRuntimeEnv } from "@/platform/config/load-runtime-config";
import type { ProductConfig } from "@/platform/config/types";

const disabled = {
  auth: { enabled: false, google: false, magicLink: false, password: false },
  email: { enabled: false },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { ga4: false, clarity: false, consentRequired: true },
} as const satisfies ProductConfig["features"];

const build = spawnSync("bun", ["run", "build:test"], {
  stdio: "inherit",
  env: {
    ...process.env,
    APP_ENV: "test",
    VERCEL_ENV: undefined,
    APP_ORIGIN: "http://localhost:3000",
    DATABASE_URL: "postgres://test:test@localhost:5432/test",
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    RESEND_API_KEY: undefined,
    WAFFO_MERCHANT_ID: undefined,
    WAFFO_PRIVATE_KEY: undefined,
    WAFFO_STORE_ID: undefined,
    WAFFO_WEBHOOK_TEST_PUBLIC_KEY: undefined,
    WAFFO_WEBHOOK_PROD_PUBLIC_KEY: undefined,
    WAFFO_CONTRACT_VERIFIED: undefined,
    COMMERCE_RETENTION_KEY: undefined,
    COMMERCE_RETENTION_KEY_ID: undefined,
    GA4_MEASUREMENT_ID: undefined,
  },
});
if (build.status !== 0) throw new Error("disabled-provider build failed");

let productionFailure: unknown;
try {
  loadRuntimeEnv(
    {
      APP_ENV: "production",
      APP_ORIGIN: "https://example.com",
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
      BETTER_AUTH_SECRET: "a".repeat(48),
      CRON_SECRET: "b".repeat(32),
    },
    {
      ...disabled,
      auth: { ...disabled.auth, enabled: true, google: true },
    },
  );
} catch (error) {
  productionFailure = error;
}
if (
  !(productionFailure instanceof Error) ||
  !productionFailure.message.includes("Google credentials")
) {
  throw new Error("production negative fixture did not fail closed");
}

let deploymentMismatch: unknown;
try {
  loadRuntimeEnv(
    {
      APP_ENV: "test",
      VERCEL_ENV: "production",
      APP_ORIGIN: "https://example.com",
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
    },
    {
      ...disabled,
      auth: { ...disabled.auth, enabled: true, magicLink: true },
      email: { enabled: true },
    },
  );
} catch (error) {
  deploymentMismatch = error;
}
if (
  !(deploymentMismatch instanceof Error) ||
  !deploymentMismatch.message.includes("VERCEL_ENV=production requires APP_ENV=production")
) {
  throw new Error("Vercel production test-mode fixture did not fail closed");
}

let commerceFailure: unknown;
try {
  loadRuntimeEnv(
    {
      APP_ENV: "staging",
      VERCEL_ENV: "preview",
      APP_ORIGIN: "https://preview.example.com",
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
      CRON_SECRET: "c".repeat(32),
      WAFFO_MERCHANT_ID: "MER_test",
      WAFFO_PRIVATE_KEY: "private-key",
      WAFFO_STORE_ID: "STO_test",
      WAFFO_WEBHOOK_TEST_PUBLIC_KEY: "test-public-key",
      COMMERCE_RETENTION_KEY: Buffer.alloc(32, 3).toString("base64"),
      COMMERCE_RETENTION_KEY_ID: "test-key",
    },
    {
      ...disabled,
      commerce: { enabled: true, oneTime: true, subscriptions: false, credits: false },
    },
  );
} catch (error) {
  commerceFailure = error;
}
if (
  !(commerceFailure instanceof Error) ||
  !commerceFailure.message.includes("Waffo contract must be verified")
) {
  throw new Error("deployed commerce contract gate did not fail closed");
}

console.log(JSON.stringify({ event: "feature_build_matrix_verified" }));
