import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabaseClient } from "@/platform/database/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");

const MAIN_BASELINE_TAG = "0007_easy_stellaris";
const database = createDatabaseClient(databaseUrl);

async function resetDatabase(): Promise<void> {
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS public CASCADE"));
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS drizzle CASCADE"));
  await database.db.execute(sql.raw("CREATE SCHEMA public"));
}

async function applyMigrations(folder = "drizzle"): Promise<void> {
  await migrate(database.db, {
    migrationsFolder: folder,
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
}

async function assertLatestSchema(label: string): Promise<void> {
  const requiredTables = [
    "platform_meta",
    "subscriptions",
    "subscription_periods",
    "refunds",
    "commerce_command_jobs",
  ];
  const tables = await database.db.execute(sql<{ table_name: string }>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in ('platform_meta','subscriptions','subscription_periods','refunds','commerce_command_jobs')
  `);
  const actualTables = new Set(tables.map((row) => row.table_name));
  for (const table of requiredTables) {
    if (!actualTables.has(table)) throw new Error(`${label}: missing migrated table ${table}`);
  }

  const billingInterval = await database.db.execute(sql<{ column_name: string }>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'commerce_products'
      and column_name = 'billing_interval'
  `);
  if (billingInterval.length !== 1) {
    throw new Error(`${label}: commerce_products.billing_interval is missing`);
  }
}

async function createMainBaselineFolder(): Promise<string> {
  const journalPath = path.join("drizzle", "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  const baselineIndex = journal.entries.findIndex((entry) => entry.tag === MAIN_BASELINE_TAG);
  if (baselineIndex < 0) throw new Error(`main migration baseline not found: ${MAIN_BASELINE_TAG}`);
  if (baselineIndex === journal.entries.length - 1) {
    throw new Error("no generated migration exists after the main baseline");
  }

  const folder = await mkdtemp(path.join(tmpdir(), "creat-web-main-migrations-"));
  await mkdir(path.join(folder, "meta"), { recursive: true });
  const entries = journal.entries.slice(0, baselineIndex + 1);
  await writeFile(
    path.join(folder, "meta", "_journal.json"),
    `${JSON.stringify({ version: journal.version, dialect: journal.dialect, entries }, null, 2)}\n`,
    "utf8",
  );
  for (const entry of entries) {
    await cp(path.join("drizzle", `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

try {
  await resetDatabase();
  await applyMigrations();
  await applyMigrations();
  await assertLatestSchema("empty database to latest");

  const baselineFolder = await createMainBaselineFolder();
  try {
    await resetDatabase();
    await applyMigrations(baselineFolder);
    await applyMigrations();
    await applyMigrations();
    await assertLatestSchema("main migration chain to latest");
  } finally {
    await rm(baselineFolder, { recursive: true, force: true });
  }

  console.log(
    JSON.stringify({
      event: "database_migration_verified",
      paths: ["empty_to_latest", "main_chain_to_latest"],
      mainBaseline: MAIN_BASELINE_TAG,
    }),
  );
} finally {
  await database.close();
}
