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
    command: "bun tests/e2e/start-enabled-test-server.ts",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    env: {
      APP_ENV: "test",
      APP_ORIGIN: "http://127.0.0.1:3000",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@localhost:5432/creat_web_test",
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "e2e-better-auth-secret-with-at-least-32-characters",
      EMAIL_TRANSPORT: "test",
      TEST_EMAIL_DIR: process.env.TEST_EMAIL_DIR ?? "/tmp/creat-web-test-emails",
      GA4_MEASUREMENT_ID: "G-E2E0000001",
      CLARITY_PROJECT_ID: "e2eclarity",
    },
  },
});
