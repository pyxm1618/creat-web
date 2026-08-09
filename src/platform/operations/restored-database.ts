import { and, eq, inArray, sql } from "drizzle-orm";

import { reconcileCreditLedger } from "@/platform/credits/application/reconcile-credit-ledger";
import type { DatabaseClient } from "@/platform/database/client";
import { accountSubjects } from "@/platform/database/schema";

const REQUIRED_RELATIONS = [
  "user",
  "session",
  "account",
  "verification",
  "rate_limit",
  "platform_meta",
  "account_subjects",
  "commerce_products",
  "orders",
  "payments",
  "payment_webhook_inbox",
  "subscriptions",
  "refunds",
  "credit_grants",
  "credit_reservations",
  "credit_ledger_entries",
] as const;

const REQUIRED_CONSTRAINTS = [
  "webhook_invalid_signature_no_raw",
  "payment_refunded_minor_valid",
  "subscription_grace_consistent",
  "refund_requested_minor_positive",
  "credit_grant_quantity_positive",
  "credit_reservation_quantity_positive",
  "credit_ledger_quantity_positive",
] as const;

const IDEMPOTENCY_TABLES = [
  "orders",
  "fulfillment_jobs",
  "commerce_command_jobs",
  "credit_grants",
  "credit_reservations",
  "credit_ledger_entries",
] as const;

export type RestoredDatabaseVerification = Readonly<{
  status: "ok";
  migrationCount: number;
  checkedRelations: number;
  checkedConstraints: number;
  checkedIdempotencyTables: number;
}>;

async function verifyRelations(database: DatabaseClient): Promise<void> {
  for (const relation of REQUIRED_RELATIONS) {
    const rows = await database.execute<{ relation: string | null }>(
      sql`select to_regclass(${`public.${relation}`})::text as relation`,
    );
    if (!rows[0]?.relation)
      throw new Error(`restored database missing required relation: ${relation}`);
  }
}

async function verifyConstraints(database: DatabaseClient): Promise<void> {
  for (const constraint of REQUIRED_CONSTRAINTS) {
    const rows = await database.execute<{ present: boolean }>(sql`
      select exists(
        select 1 from pg_constraint where conname = ${constraint}
      ) as present
    `);
    if (!rows[0]?.present) throw new Error(`restored database missing constraint: ${constraint}`);
  }
}

async function verifyIdempotencyUniqueness(database: DatabaseClient): Promise<void> {
  for (const table of IDEMPOTENCY_TABLES) {
    const rows = await database.execute<{ duplicates: number }>(
      sql.raw(`
      select count(*)::int as duplicates from (
        select idempotency_key from ${table}
        where idempotency_key is not null
        group by idempotency_key having count(*) > 1
      ) duplicate_keys
    `),
    );
    if (Number(rows[0]?.duplicates ?? 0) !== 0) {
      throw new Error(`restored database contains duplicate idempotency keys in ${table}`);
    }
  }
}

async function verifyOwnerScopedReads(database: DatabaseClient): Promise<void> {
  await database.transaction(async (tx) => {
    const subjects = await tx
      .insert(accountSubjects)
      .values([{}, {}])
      .returning({ id: accountSubjects.id });
    if (subjects.length !== 2 || !subjects[0] || !subjects[1]) {
      throw new Error("synthetic owner-scope setup failed");
    }
    const own = await tx.query.accountSubjects.findFirst({
      where: and(eq(accountSubjects.id, subjects[0].id), eq(accountSubjects.status, "active")),
    });
    const other = await tx.query.accountSubjects.findFirst({
      where: and(eq(accountSubjects.id, subjects[1].id), eq(accountSubjects.status, "active")),
    });
    if (!own || !other || own.id === other.id)
      throw new Error("synthetic owner-scoped read failed");
    await tx.delete(accountSubjects).where(
      inArray(
        accountSubjects.id,
        subjects.map((row) => row.id),
      ),
    );
  });
}

export async function verifyRestoredDatabase(
  database: DatabaseClient,
): Promise<RestoredDatabaseVerification> {
  const migrationRows = await database.execute<{ count: number }>(
    sql.raw("select count(*)::int as count from drizzle.__drizzle_migrations"),
  );
  const migrationCount = Number(migrationRows[0]?.count ?? 0);
  if (migrationCount < 1) throw new Error("restored database has no migration history");

  await verifyRelations(database);
  await verifyConstraints(database);
  await verifyIdempotencyUniqueness(database);

  const creditIssues = await reconcileCreditLedger(database);
  if (creditIssues.length > 0) {
    throw new Error(`restored database credit reconciliation failed: ${creditIssues[0]?.code}`);
  }
  await verifyOwnerScopedReads(database);

  return {
    status: "ok",
    migrationCount,
    checkedRelations: REQUIRED_RELATIONS.length,
    checkedConstraints: REQUIRED_CONSTRAINTS.length,
    checkedIdempotencyTables: IDEMPOTENCY_TABLES.length,
  };
}
