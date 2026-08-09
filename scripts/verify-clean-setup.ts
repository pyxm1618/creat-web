import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";

import { createDatabaseClient } from "@/platform/database/client";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.CLEAN_SETUP_DATABASE_URL;
if (!databaseUrl) throw new Error("CLEAN_SETUP_DATABASE_URL is required");

const expectedConfig = new Set([
  "src/config/features.config.ts",
  "src/config/legal.config.ts",
  "src/config/products.config.ts",
  "src/config/routes.config.ts",
  "src/config/seo.config.ts",
  "src/config/site.config.ts",
]);

function gitStatus(cwd: string): string[] {
  const output = execFileSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  }).trim();
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
}

function assertNeutralConfigApplied(cwd: string): void {
  const actual = new Set(gitStatus(cwd));
  for (const path of actual) {
    if (!expectedConfig.has(path)) {
      throw new Error(`clean setup changed undocumented path: ${path}`);
    }
  }

  for (const targetPath of expectedConfig) {
    const fileName = targetPath.split("/").at(-1);
    if (!fileName) throw new Error(`invalid expected config path: ${targetPath}`);
    const sourcePath = join(cwd, "examples", "neutral-product", fileName);
    const resolvedTarget = join(cwd, targetPath);
    if (readFileSync(sourcePath, "utf8") !== readFileSync(resolvedTarget, "utf8")) {
      throw new Error(`clean setup did not apply neutral config: ${targetPath}`);
    }
  }
}

function run(
  cwd: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`clean setup command failed: ${command} ${args.join(" ")}`);
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "creat-web-clean-"));
const checkout = join(temporaryRoot, "checkout");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const database = createDatabaseClient(databaseUrl);

try {
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS public CASCADE"));
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS drizzle CASCADE"));
  await database.db.execute(sql.raw("CREATE SCHEMA public"));
  await database.close();

  run(root, "git", ["clone", "--no-hardlinks", "--quiet", root, checkout], process.env);
  run(checkout, "git", ["checkout", "--detach", "--quiet", commit], process.env);
  if (gitStatus(checkout).length !== 0) throw new Error("fresh checkout is unexpectedly dirty");

  run(checkout, "bun", ["install", "--frozen-lockfile"], process.env);
  run(checkout, "bun", ["scripts/apply-example-config.ts"], process.env);
  assertNeutralConfigApplied(checkout);

  const forbidden = spawnSync(
    "git",
    [
      "grep",
      "-n",
      "-i",
      "-E",
      "quick[ -]?i[ -]?ching|ichingcoin|hexagram|casting",
      "--",
      "src",
      "examples/neutral-product",
    ],
    { cwd: checkout, encoding: "utf8" },
  );
  if (forbidden.status === 0) {
    throw new Error(`product-specific reference found in clean sample:\n${forbidden.stdout}`);
  }
  if (forbidden.status !== 1) throw new Error("forbidden-reference scan failed to execute");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: "test",
    APP_ORIGIN: "http://127.0.0.1:3000",
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: "clean-setup-auth-secret-with-more-than-32-characters",
    CRON_SECRET: "clean-setup-cron-secret-32-characters-minimum",
    EMAIL_TRANSPORT: "test",
    TEST_EMAIL_DIR: join(temporaryRoot, "mailbox"),
    GOOGLE_CLIENT_ID: "clean-setup-google-client-id.test.apps.exampleusercontent.com",
    GOOGLE_CLIENT_SECRET: "clean-setup-google-client-secret-value",
    WAFFO_MERCHANT_ID: "clean-setup-test-merchant",
    WAFFO_PRIVATE_KEY: "clean-setup-test-private-key",
    WAFFO_STORE_ID: "clean-setup-test-store",
    WAFFO_WEBHOOK_TEST_PUBLIC_KEY: "clean-setup-test-webhook-public-key",
    COMMERCE_RETENTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    COMMERCE_RETENTION_KEY_ID: "clean-setup-test-key-v1",
    GA4_MEASUREMENT_ID: "G-CLEANSETUP",
    CLARITY_PROJECT_ID: "clean-setup-clarity",
  };

  const commands: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["bun", ["run", "db:migrate"]],
    ["bun", ["run", "format:check"]],
    ["bun", ["run", "lint"]],
    ["bun", ["run", "typecheck"]],
    ["bun", ["run", "test:unit"]],
    ["bun", ["run", "test:integration"]],
    ["bun", ["run", "test:contract"]],
    ["bun", ["run", "build"]],
    ["bun", ["run", "test:e2e"]],
    ["bun", ["run", "verify:architecture"]],
    ["bun", ["run", "verify:secrets"]],
    ["bun", ["run", "verify:security"]],
    ["bun", ["run", "verify:release", "--mode=test"]],
  ];
  for (const [command, args] of commands) run(checkout, command, args, env);

  assertNeutralConfigApplied(checkout);
  console.log(JSON.stringify({ event: "clean_setup_verified", commit, product: "focus-planner" }));
} finally {
  await database.close().catch(() => undefined);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
