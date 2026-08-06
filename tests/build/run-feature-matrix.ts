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
    APP_ORIGIN: "http://localhost:3000",
    DATABASE_URL: "postgres://test:test@localhost:5432/test",
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    RESEND_API_KEY: undefined,
    WAFFO_PRIVATE_KEY: undefined,
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

console.log(JSON.stringify({ event: "feature_build_matrix_verified" }));
