import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { featuresConfig } from "@/config/features.config";
import { legalConfig } from "@/config/legal.config";
import { seoConfig } from "@/config/seo.config";
import { siteConfig } from "@/config/site.config";
import { loadRuntimeEnv } from "@/platform/config/load-runtime-config";
import { validateProductConfig } from "@/platform/config/validate-config";
import { validateLegalConfig } from "@/platform/legal/validate-legal-config";

validateProductConfig({ site: siteConfig, features: featuresConfig });

const legalFeatures = {
  google: featuresConfig.auth.google,
  resend: featuresConfig.auth.magicLink || featuresConfig.email.enabled,
  waffo: featuresConfig.commerce.enabled,
  ga4: featuresConfig.analytics.ga4,
  clarity: featuresConfig.analytics.clarity,
  subscriptions: featuresConfig.commerce.subscriptions,
  credits: featuresConfig.commerce.credits,
} as const;

validateLegalConfig({
  legal: legalConfig,
  features: legalFeatures,
  releaseMode: process.env.APP_ENV === "production",
});

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

if (process.env.APP_ENV === "production") {
  if (seoConfig.releaseStatus !== "reviewed")
    throw new Error("production SEO config is not reviewed");
  if (/example\.com/i.test(siteConfig.canonicalOrigin)) {
    throw new Error("production site origin is still a placeholder");
  }
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

let rejectedDraftLegalRelease = false;
try {
  validateLegalConfig({ legal: legalConfig, features: legalFeatures, releaseMode: true });
} catch {
  rejectedDraftLegalRelease = true;
}
if (legalConfig.releaseStatus === "draft" && !rejectedDraftLegalRelease) {
  throw new Error("production release gate must reject draft legal configuration");
}

const vercelConfig = JSON.parse(await readFile("vercel.json", "utf8")) as {
  crons?: Array<{ path?: string }>;
};
if (!vercelConfig.crons?.some((cron) => cron.path === "/api/cron/account-deletions")) {
  throw new Error("durable account deletion cron is missing from vercel.json");
}

console.log(
  JSON.stringify({
    event: "release_verified",
    site: siteConfig.slug,
    authEnabled: featuresConfig.auth.enabled,
    magicLinkEnabled: featuresConfig.auth.magicLink,
    commerceEnabled: featuresConfig.commerce.enabled,
    seoStatus: seoConfig.releaseStatus,
    legalStatus: legalConfig.releaseStatus,
    productionTestModeRejected: true,
    productionDraftLegalRejected: true,
  }),
);
