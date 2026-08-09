import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { grantCredits } from "@/platform/credits/application/credit-service";
import { createDatabaseClient } from "@/platform/database/client";
import { accountSubjects } from "@/platform/database/schema";

export function createCreditTestDatabase() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  return createDatabaseClient(databaseUrl);
}

export async function resetCreditTestDatabase(
  database: ReturnType<typeof createDatabaseClient>["db"],
): Promise<void> {
  await database.execute(sql.raw("DROP SCHEMA IF EXISTS public CASCADE"));
  await database.execute(sql.raw("DROP SCHEMA IF EXISTS drizzle CASCADE"));
  await database.execute(sql.raw("CREATE SCHEMA public"));
  await migrate(database, {
    migrationsFolder: "drizzle",
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
}

export async function createCreditSubject(
  database: ReturnType<typeof createDatabaseClient>["db"],
): Promise<string> {
  const [row] = await database.insert(accountSubjects).values({}).returning();
  if (!row) throw new Error("subject insert failed");
  return row.id;
}

export async function createExpiringGrant(
  database: ReturnType<typeof createDatabaseClient>["db"],
  input: {
    subjectId: string;
    quantity: number;
    expiresAt: Date;
    suffix?: string;
  },
) {
  const suffix = input.suffix ?? crypto.randomUUID();
  return grantCredits(database, {
    subjectId: input.subjectId,
    creditType: "reading",
    quantity: input.quantity,
    source: { type: "promotion", id: `source-${suffix}` },
    idempotencyKey: `grant-${suffix}`,
    expiresAt: input.expiresAt,
    actor: "system",
  });
}
