import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabaseClient } from "@/platform/database/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");

const MAIN_BASELINE_TAG = "0010_credit_finalization_lease_token";
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
    "credit_reconciliation_incidents",
    "payment_reconciliation_jobs",
  ];
  const tables = await database.db.execute(sql<{ table_name: string }>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in ('platform_meta','subscriptions','subscription_periods','refunds','commerce_command_jobs','credit_reconciliation_incidents','payment_reconciliation_jobs')
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

  const finalizationLeaseToken = await database.db.execute(sql<{ column_name: string }>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'credit_finalization_jobs'
      and column_name = 'lease_token'
  `);
  if (finalizationLeaseToken.length !== 1) {
    throw new Error(`${label}: credit_finalization_jobs.lease_token is missing`);
  }

  const reconciliationColumns = await database.db.execute(sql<{ column_name: string }>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payment_reconciliation_jobs'
  `);
  const actualReconciliationColumns = new Set(reconciliationColumns.map((row) => row.column_name));
  for (const column of [
    "order_id",
    "environment",
    "state",
    "attempts",
    "lease_owner",
    "lease_token",
    "lease_expires_at",
    "next_attempt_at",
    "operator_review_reason",
    "completed_at",
  ]) {
    if (!actualReconciliationColumns.has(column)) {
      throw new Error(`${label}: payment_reconciliation_jobs.${column} is missing`);
    }
  }

  const reconciliationConstraints = await database.db.execute(sql<{ constraint_name: string }>`
    select constraint_name
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'payment_reconciliation_jobs'
  `);
  const actualReconciliationConstraints = new Set(
    reconciliationConstraints.map((row) => row.constraint_name),
  );
  for (const constraint of [
    "payment_reconciliation_job_state_valid",
    "payment_reconciliation_job_environment_valid",
    "payment_reconciliation_job_attempts_nonnegative",
    "payment_reconciliation_job_lease_consistent",
    "payment_reconciliation_job_review_reason_consistent",
    "payment_reconciliation_job_terminal_time_consistent",
  ]) {
    if (!actualReconciliationConstraints.has(constraint)) {
      throw new Error(`${label}: missing payment reconciliation constraint ${constraint}`);
    }
  }

  const reconciliationIndexes = await database.db.execute(sql<{ indexname: string }>`
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and indexname in ('payment_reconciliation_order_uq','payment_reconciliation_due_idx','payment_reconciliation_reclaim_idx','commerce_reconciliation_run_dedup_uq')
  `);
  const actualReconciliationIndexes = new Set(reconciliationIndexes.map((row) => row.indexname));
  for (const index of [
    "payment_reconciliation_order_uq",
    "payment_reconciliation_due_idx",
    "payment_reconciliation_reclaim_idx",
    "commerce_reconciliation_run_dedup_uq",
  ]) {
    if (!actualReconciliationIndexes.has(index)) {
      throw new Error(`${label}: missing payment reconciliation index ${index}`);
    }
  }

  const reconciliationDedupKey = await database.db.execute(sql<{ column_name: string }>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'commerce_reconciliation_runs'
      and column_name = 'dedup_key'
  `);
  if (reconciliationDedupKey.length !== 1) {
    throw new Error(`${label}: commerce_reconciliation_runs.dedup_key is missing`);
  }

  const triggerFunctions = await database.db.execute(sql<{ function_name: string }>`
    select p.proname as function_name
    from pg_proc p
    inner join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'reject_credit_ledger_mutation'
  `);
  if (triggerFunctions.length !== 1) {
    throw new Error(`${label}: reject_credit_ledger_mutation function is missing`);
  }

  const ledgerTriggers = await database.db.execute(
    sql<{ trigger_name: string; function_name: string; enabled: string }>`
      select t.tgname as trigger_name, p.proname as function_name, t.tgenabled as enabled
      from pg_trigger t
      inner join pg_class c on c.oid = t.tgrelid
      inner join pg_namespace n on n.oid = c.relnamespace
      inner join pg_proc p on p.oid = t.tgfoid
      where n.nspname = 'public'
        and c.relname = 'credit_ledger_entries'
        and t.tgname = 'credit_ledger_entries_append_only'
        and not t.tgisinternal
    `,
  );
  if (
    ledgerTriggers.length !== 1 ||
    ledgerTriggers[0]?.function_name !== "reject_credit_ledger_mutation" ||
    ledgerTriggers[0]?.enabled === "D"
  ) {
    throw new Error(`${label}: credit_ledger_entries_append_only trigger is missing or disabled`);
  }
}

async function createMainBaselineFolder(): Promise<string> {
  const journalPath = path.join("drizzle", "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    version: string;
    dialect: string;
    entries: Array<{
      idx: number;
      version: string;
      when: number;
      tag: string;
      breakpoints: boolean;
    }>;
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
