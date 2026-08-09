import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createDatabaseClient } from "@/platform/database/client";
import { verifyRestoredDatabase } from "@/platform/operations/restored-database";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabaseClient(databaseUrl);

beforeAll(async () => {
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS public CASCADE"));
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS drizzle CASCADE"));
  await database.db.execute(sql.raw("CREATE SCHEMA public"));
  await migrate(database.db, {
    migrationsFolder: "drizzle",
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
});

afterAll(async () => database.close());

it("validates migration history auth tables constraints idempotency and credit reconciliation", async () => {
  const result = await verifyRestoredDatabase(database.db);
  expect(result.status).toBe("ok");
  expect(result.migrationCount).toBeGreaterThan(0);
  expect(result.checkedRelations).toBeGreaterThan(10);
  expect(result.checkedConstraints).toBeGreaterThan(5);
  expect(result.checkedIdempotencyTables).toBeGreaterThan(5);
});

it("reports an idempotency schema rename as a verifier error", async () => {
  await database.db.execute(
    sql.raw(
      'alter table "orders" rename column "checkout_idempotency_key" to "renamed_checkout_idempotency_key"',
    ),
  );

  try {
    await expect(verifyRestoredDatabase(database.db)).rejects.toThrow(
      "restored database missing idempotency column: orders.checkout_idempotency_key",
    );
  } finally {
    await database.db.execute(
      sql.raw(
        'alter table "orders" rename column "renamed_checkout_idempotency_key" to "checkout_idempotency_key"',
      ),
    );
  }
});
