import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { featuresConfig } from "@/config/features.config";
import { legalConfig } from "@/config/legal.config";
import { seoConfig } from "@/config/seo.config";
import { siteConfig } from "@/config/site.config";
import { TEMPLATE_VERSION } from "@/config/template-version";
import { loadRuntimeEnv } from "@/platform/config/load-runtime-config";
import { validateProductConfig } from "@/platform/config/validate-config";
import { validateLegalConfig } from "@/platform/legal/validate-legal-config";

import { probeCommerceAccountDeletionCoordinator } from "./account-deletion-release-probe";

const modeArgument = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7);
if (modeArgument && !["test", "staging", "production"].includes(modeArgument)) {
  throw new Error("--mode must be test, staging, or production");
}
const releaseMode = modeArgument ?? process.env.APP_ENV ?? "test";
const productionRelease = releaseMode === "production";
const seoReleaseStatus: string = seoConfig.releaseStatus;
const legalReleaseStatus: string = legalConfig.releaseStatus;

validateProductConfig({ site: siteConfig, features: featuresConfig });
if (!/^\d+\.\d+\.\d+$/.test(TEMPLATE_VERSION)) {
  throw new Error("starter template version must use semantic versioning");
}

const legalFeatures = {
  google: featuresConfig.auth.google,
  resend: featuresConfig.auth.magicLink || featuresConfig.email.enabled,
  waffo: featuresConfig.commerce.enabled,
  ga4: featuresConfig.analytics.ga4,
  clarity: featuresConfig.analytics.clarity,
  oneTime: featuresConfig.commerce.oneTime,
  subscriptions: featuresConfig.commerce.subscriptions,
  credits: featuresConfig.commerce.credits,
} as const;

validateLegalConfig({
  legal: legalConfig,
  features: legalFeatures,
  releaseMode: productionRelease,
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
if (productionRelease) {
  if (seoReleaseStatus !== "reviewed") throw new Error("production SEO config is not reviewed");
  if (legalReleaseStatus !== "reviewed") throw new Error("production legal config is not reviewed");
  if (/example\.(?:com|org|net)$/i.test(new URL(siteConfig.canonicalOrigin).hostname)) {
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
if (legalReleaseStatus === "draft" && !rejectedDraftLegalRelease) {
  throw new Error("production release gate must reject draft legal configuration");
}

const vercelConfig = JSON.parse(await readFile("vercel.json", "utf8")) as {
  crons?: Array<{ path?: string }>;
};
const scheduledPaths = new Set(vercelConfig.crons?.map((cron) => cron.path) ?? []);
for (const required of ["/api/internal/jobs/account-deletion", "/api/internal/jobs/reconcile"]) {
  if (!scheduledPaths.has(required))
    throw new Error(`required internal schedule is missing: ${required}`);
}
if (featuresConfig.commerce.enabled && !scheduledPaths.has("/api/internal/jobs/commerce")) {
  throw new Error("durable commerce recovery job is missing from vercel.json");
}
if (featuresConfig.commerce.credits && !scheduledPaths.has("/api/internal/jobs/credit-expiry")) {
  throw new Error("durable credit expiry job is missing from vercel.json");
}

for (const requiredFile of [
  "SECURITY.md",
  "CHANGELOG.md",
  "docs/runbooks/database-backup-restore.md",
  "docs/runbooks/key-rotation.md",
  "docs/runbooks/release-rollback.md",
  "docs/runbooks/dead-letters.md",
  "docs/runbooks/data-retention.md",
  "docs/upgrade/owned-project-upgrades.md",
]) {
  await readFile(requiredFile, "utf8");
}

const accountDeletionRuntimeSource = await readFile(
  "src/platform/accounts/account-deletion-runtime.ts",
  "utf8",
);
const accountDeletionCoordinatorInput = accountDeletionRuntimeSource.match(
  /createPlatformAccountDeletionCoordinator\(\{(?<input>[^}]+)\}\)/m,
)?.groups?.input;
if (
  !accountDeletionCoordinatorInput ||
  !/\bdatabase:\s*db\b/.test(accountDeletionCoordinatorInput) ||
  !/\bgetCommerce:\s*getCommerceRuntime\b/.test(accountDeletionCoordinatorInput)
) {
  throw new Error("commerce-enabled account deletion coordinator must be wired");
}
await probeCommerceAccountDeletionCoordinator();

console.log(
  JSON.stringify({
    event: "release_verified",
    site: siteConfig.slug,
    templateVersion: TEMPLATE_VERSION,
    mode: releaseMode,
    authEnabled: featuresConfig.auth.enabled,
    magicLinkEnabled: featuresConfig.auth.magicLink,
    commerceEnabled: featuresConfig.commerce.enabled,
    seoStatus: seoReleaseStatus,
    legalStatus: legalReleaseStatus,
    productionTestModeRejected: true,
    productionDraftLegalRejected: true,
  }),
);
