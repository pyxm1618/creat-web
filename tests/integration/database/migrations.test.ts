import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabaseClient } from "@/platform/database/client";
import { platformMeta } from "@/platform/database/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const database = createDatabaseClient(databaseUrl);

beforeAll(async () => {
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS public CASCADE"));
  await database.db.execute(sql.raw("CREATE SCHEMA public"));
  await migrate(database.db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await database.close();
});

it("applies the complete migration chain repeatedly", async () => {
  await migrate(database.db, { migrationsFolder: "drizzle" });

  await database.db.insert(platformMeta).values({ key: "schema", value: "foundation" });
  const rows = await database.db
    .select()
    .from(platformMeta)
    .where(eq(platformMeta.key, "schema"));

  expect(rows).toEqual([
    expect.objectContaining({ key: "schema", value: "foundation" }),
  ]);
});

it("creates the Drizzle migration history outside application tables", async () => {
  const result = await database.db.execute(sql<{
    table_schema: string;
    table_name: string;
  }>`
    select table_schema, table_name
    from information_schema.tables
    where table_name = '__drizzle_migrations'
  `);

  expect(result.length).toBe(1);
});
