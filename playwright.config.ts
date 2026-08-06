import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    env: {
      APP_ENV: "test",
      APP_ORIGIN: "http://127.0.0.1:3000",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@localhost:5432/creat_web_test",
    },
  },
});
