import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabaseClient } from "@/platform/database/client";

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

afterAll(async () => {
  await database.close();
});

it("installs canonical Better Auth and durable rate-limit tables", async () => {
  const rows = await database.db.execute(sql<{ table_name: string }>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
  `);
  const names = rows.map((row) => row.table_name);

  expect(names).toEqual(
    expect.arrayContaining(["user", "session", "account", "verification", "rateLimit"]),
  );
});
