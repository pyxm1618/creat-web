import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/performance-analytics",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3200",
    trace: "retain-on-failure",
  },
  projects: [{ name: "mobile-analytics-on", use: { ...devices["Pixel 7"] } }],
  webServer: {
    command: "bun run build:test && bun run start -- -p 3200",
    url: "http://127.0.0.1:3200",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      APP_ENV: "test",
      APP_ORIGIN: "http://127.0.0.1:3200",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@localhost:5432/creat_web_test",
      CREAT_WEB_PERFORMANCE_ANALYTICS: "1",
      GA4_MEASUREMENT_ID: "G-TESTPERF1",
      CLARITY_PROJECT_ID: "test-perf-clarity",
    },
  },
});
