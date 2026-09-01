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

async function readReleaseArtifact(
  root: string,
  file: string,
  missingMessage: string,
): Promise<string> {
  try {
    return await readFile(path.join(root, file), "utf8");
  } catch {
    throw new Error(missingMessage);
  }
}

export async function verifyCreditsReleaseArtifacts(root: string): Promise<void> {
  const integrityMigration = await readReleaseArtifact(
    root,
    "drizzle/0009_production_readiness.sql",
    "durable credit ledger integrity migration is missing",
  );
  const leaseMigration = await readReleaseArtifact(
    root,
    "drizzle/0010_credit_finalization_lease_token.sql",
    "credit finalization lease migration is missing",
  );
  const executableIntegrityMigration = stripSqlComments(integrityMigration);
  const ledgerFunction =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?reject_credit_ledger_mutation"?\s*\(/i.test(
      executableIntegrityMigration,
    );
  const ledgerTrigger = executableIntegrityMigration.match(
    /\bCREATE\s+TRIGGER\s+"?credit_ledger_entries_append_only"?[\s\S]*?;/i,
  )?.[0];
  if (
    !ledgerFunction ||
    !ledgerTrigger ||
    !/\bBEFORE\b/i.test(ledgerTrigger) ||
    !/\bUPDATE\b/i.test(ledgerTrigger) ||
    !/\bDELETE\b/i.test(ledgerTrigger) ||
    !/\bON\s+(?:ONLY\s+)?"?credit_ledger_entries"?\b/i.test(ledgerTrigger) ||
    !/\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+"?reject_credit_ledger_mutation"?\s*\(/i.test(
      ledgerTrigger,
    )
  ) {
    throw new Error("durable credit ledger integrity migration is not executable");
  }

  const executableLeaseMigration = stripSqlComments(leaseMigration);
  if (
    !/\bALTER\s+TABLE\s+(?:ONLY\s+)?"?credit_finalization_jobs"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?lease_token"?\s+text\b/i.test(
      executableLeaseMigration,
    )
  ) {
    throw new Error("credit finalization lease migration is not executable");
  }

  const journal = await readJsonArtifact(
    root,
    "drizzle/meta/_journal.json",
    "durable Credits migrations are missing from the migration journal",
  );
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const integrityIndex = entries.findIndex(
    (entry) => isRecord(entry) && entry.tag === "0009_production_readiness",
  );
  const leaseIndex = entries.findIndex(
    (entry) => isRecord(entry) && entry.tag === "0010_credit_finalization_lease_token",
  );
  const integrityOccurrences = entries.filter(
    (entry) => isRecord(entry) && entry.tag === "0009_production_readiness",
  ).length;
  const leaseOccurrences = entries.filter(
    (entry) => isRecord(entry) && entry.tag === "0010_credit_finalization_lease_token",
  ).length;
  if (
    journal.dialect !== "postgresql" ||
    typeof journal.version !== "string" ||
    integrityIndex !== 9 ||
    leaseIndex !== 10 ||
    integrityOccurrences !== 1 ||
    leaseOccurrences !== 1 ||
    !validJournalEntry(entries[integrityIndex], integrityIndex, journal.version) ||
    !validJournalEntry(entries[leaseIndex], leaseIndex, journal.version)
  ) {
    throw new Error("durable Credits migrations are missing from the migration journal");
  }

  const integritySnapshot = await readJsonArtifact(
    root,
    "drizzle/meta/0009_snapshot.json",
    "credit reconciliation incident snapshot is incomplete",
  );
  const leaseSnapshot = await readJsonArtifact(
    root,
    "drizzle/meta/0010_snapshot.json",
    "credit finalization lease snapshot is incomplete",
  );
  if (
    !validSnapshotHeader(integritySnapshot, journal.version) ||
    !validSnapshotHeader(leaseSnapshot, journal.version) ||
    leaseSnapshot.prevId !== integritySnapshot.id
  ) {
    throw new Error("Credits migration snapshots are not contiguous");
  }
  if (!hasDurableIncidentSchema(integritySnapshot)) {
    throw new Error("credit reconciliation incident snapshot is incomplete");
  }
  if (
    hasFinalizationLeaseToken(integritySnapshot) ||
    !hasDurableIncidentSchema(leaseSnapshot) ||
    !hasFinalizationLeaseToken(leaseSnapshot)
  ) {
    throw new Error("credit finalization lease snapshot is incomplete");
  }

  console.log(JSON.stringify({ event: "credits_release_artifacts_verified" }));
}

function stripSqlComments(sql: string): string {
  let output = "";
  let index = 0;
  let state:
    | "normal"
    | "standard-single"
    | "escape-single"
    | "double"
    | "line"
    | "block"
    | "dollar" = "normal";
  let blockDepth = 0;
  let dollarTag = "";

  while (index < sql.length) {
    const current = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    if (state === "line") {
      if (current === "\n") {
        state = "normal";
        output += current;
      }
      index += 1;
      continue;
    }
    if (state === "block") {
      if (current === "/" && next === "*") {
        blockDepth += 1;
        output += "  ";
        index += 2;
      } else if (current === "*" && next === "/") {
        blockDepth -= 1;
        if (blockDepth === 0) state = "normal";
        output += "  ";
        index += 2;
      } else {
        output += current === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (state === "dollar") {
      if (sql.startsWith(dollarTag, index)) {
        output += dollarTag;
        index += dollarTag.length;
        state = "normal";
      } else {
        output += current === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (state === "standard-single" || state === "escape-single" || state === "double") {
      const singleQuoted = state !== "double";
      const quote = singleQuoted ? "'" : '"';
      if (state === "escape-single" && current === "\\") {
        output += next === "\n" ? " \n" : next ? "  " : " ";
        index += next ? 2 : 1;
        continue;
      }
      output += singleQuoted && current !== quote ? " " : current;
      if (current === quote) {
        if (next === quote) {
          output += next;
          index += 2;
          continue;
        }
        state = "normal";
      }
      index += 1;
      continue;
    }
    if (current === "-" && next === "-") {
      state = "line";
      output += "  ";
      index += 2;
      continue;
    }
    if (current === "/" && next === "*") {
      state = "block";
      blockDepth = 1;
      output += "  ";
      index += 2;
      continue;
    }
    if (current === "'") {
      const prefix = sql[index - 1] ?? "";
      const beforePrefix = sql[index - 2] ?? "";
      state =
        (prefix === "E" || prefix === "e") && !/[A-Za-z0-9_$]/.test(beforePrefix)
          ? "escape-single"
          : "standard-single";
    } else if (current === '"') state = "double";
    else if (current === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarTag = match[0];
        state = "dollar";
        output += dollarTag;
        index += dollarTag.length;
        continue;
      }
    }
    output += current;
    index += 1;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonArtifact(
  root: string,
  file: string,
  invalidMessage: string,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(root, file), "utf8"));
    if (!isRecord(value)) throw new Error(invalidMessage);
    return value;
  } catch {
    throw new Error(invalidMessage);
  }
}

function validJournalEntry(entry: unknown, index: number, version: string): boolean {
  return (
    isRecord(entry) &&
    entry.idx === index &&
    entry.version === version &&
    entry.breakpoints === true
  );
}

function validSnapshotHeader(snapshot: Record<string, unknown>, version: string): boolean {
  return (
    typeof snapshot.id === "string" &&
    typeof snapshot.prevId === "string" &&
    snapshot.version === version &&
    snapshot.dialect === "postgresql" &&
    isRecord(snapshot.tables)
  );
}

function snapshotTable(
  snapshot: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  if (!isRecord(snapshot.tables)) return undefined;
  const table = snapshot.tables[name];
  return isRecord(table) ? table : undefined;
}

function hasDurableIncidentSchema(snapshot: Record<string, unknown>): boolean {
  const table = snapshotTable(snapshot, "public.credit_reconciliation_incidents");
  if (!table || !isRecord(table.columns) || !isRecord(table.indexes)) return false;
  const columns = table.columns;
  const requiredColumns = [
    ["id", "uuid", true],
    ["code", "text", true],
    ["entity_id", "text", true],
    ["detail", "text", true],
    ["status", "text", true],
    ["occurrences", "integer", true],
    ["first_detected_at", "timestamp with time zone", true],
    ["last_detected_at", "timestamp with time zone", true],
    ["resolved_at", "timestamp with time zone", false],
  ] as const;
  const uniqueIndex = table.indexes.credit_reconciliation_incident_uq;
  const uniqueColumns =
    isRecord(uniqueIndex) && Array.isArray(uniqueIndex.columns)
      ? uniqueIndex.columns.map((column) => (isRecord(column) ? column.expression : undefined))
      : [];
  return (
    requiredColumns.every(([name, type, notNull]) => {
      const column = columns[name];
      return isRecord(column) && column.type === type && column.notNull === notNull;
    }) &&
    isRecord(uniqueIndex) &&
    uniqueIndex.isUnique === true &&
    uniqueColumns.length === 2 &&
    uniqueColumns[0] === "code" &&
    uniqueColumns[1] === "entity_id"
  );
}

function hasFinalizationLeaseToken(snapshot: Record<string, unknown>): boolean {
  const table = snapshotTable(snapshot, "public.credit_finalization_jobs");
  if (!table || !isRecord(table.columns)) return false;
  const leaseToken = table.columns.lease_token;
  return isRecord(leaseToken) && leaseToken.type === "text" && leaseToken.notNull === false;
}

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

await verifyCreditsReleaseArtifacts(".");

for (const requiredFile of [
  "SECURITY.md",
  "CHANGELOG.md",
  "docs/建站手册.md",
  "docs/运维/故障处理.md",
  "docs/运维/密钥轮换.md",
  "docs/运维/交易与积分.md",
  "docs/运维/上线检查清单.md",
  "docs/参考/扩展与升级.md",
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
