import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { featuresConfig } from "@/config/features.config";
import { siteConfig } from "@/config/site.config";
import { loadRuntimeEnv } from "@/platform/config/load-runtime-config";
import { validateProductConfig } from "@/platform/config/validate-config";

validateProductConfig({ site: siteConfig, features: featuresConfig });

const forbidden = [/quick[ -]?i[ -]?ching/i, /ichingcoin/i, /hexagram/i, /casting/i];

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(target)));
    else if (/\.(?:ts|tsx|css|json)$/.test(entry.name)) files.push(target);
  }
  return files;
}

for (const file of await collectFiles("src")) {
  const content = await readFile(file, "utf8");
  const match = forbidden.find((pattern) => pattern.test(content));
  if (match) throw new Error(`product-specific content found in ${file}: ${match}`);
}

if (siteConfig.canonicalOrigin.includes("localhost")) {
  throw new Error("release site origin must not use localhost");
}

let rejectedVercelTestMode = false;
try {
  loadRuntimeEnv(
    {
      APP_ENV: "test",
      VERCEL_ENV: "production",
      APP_ORIGIN: "https://example.com",
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
    },
    featuresConfig,
  );
} catch {
  rejectedVercelTestMode = true;
}
if (!rejectedVercelTestMode) {
  throw new Error("production safety gate must reject APP_ENV=test on Vercel");
}

let rejectedProductionTestMailbox = false;
try {
  loadRuntimeEnv(
    {
      APP_ENV: "production",
      VERCEL_ENV: "production",
      APP_ORIGIN: "https://example.com",
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
      BETTER_AUTH_SECRET: "a".repeat(48),
      CRON_SECRET: "b".repeat(32),
      RESEND_API_KEY: "re_release_fixture",
      EMAIL_FROM: "Example <login@example.com>",
      SUPPORT_EMAIL: "support@example.com",
      TEST_EMAIL_DIR: "/tmp/forbidden-production-mailbox",
    },
    featuresConfig,
  );
} catch {
  rejectedProductionTestMailbox = true;
}
if (!rejectedProductionTestMailbox) {
  throw new Error("production safety gate must reject test mailbox configuration");
}

const vercelConfig = JSON.parse(await readFile("vercel.json", "utf8")) as {
  crons?: Array<{ path?: string }>;
};
if (!vercelConfig.crons?.some((cron) => cron.path === "/api/cron/account-deletions")) {
  throw new Error("durable account deletion cron is missing from vercel.json");
}

console.log(
  JSON.stringify({
    event: "foundation_release_verified",
    site: siteConfig.slug,
    authEnabled: featuresConfig.auth.enabled,
    magicLinkEnabled: featuresConfig.auth.magicLink,
    commerceEnabled: featuresConfig.commerce.enabled,
    productionTestModeRejected: true,
  }),
);
