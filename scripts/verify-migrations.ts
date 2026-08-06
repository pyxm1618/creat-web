import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabaseClient } from "@/platform/database/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");

const database = createDatabaseClient(databaseUrl);

try {
  await migrate(database.db, {
    migrationsFolder: "drizzle",
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
  await migrate(database.db, {
    migrationsFolder: "drizzle",
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });

  const tables = await database.db.execute(sql<{ table_name: string }>`
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_name = 'platform_meta'
  `);
  if (tables.length !== 1) throw new Error("foundation schema verification failed");

  console.log(JSON.stringify({ event: "database_migration_verified", tables: ["platform_meta"] }));
} finally {
  await database.close();
}
