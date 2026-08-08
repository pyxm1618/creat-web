import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { recordLegalAcceptance } from "@/platform/legal/acceptance";
import { createDatabaseClient } from "@/platform/database/client";
import { accountSubjects, legalAcceptances, user } from "@/platform/database/schema";

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

it("stores one acceptance for repeated subject/document/version writes", async () => {
  await database.db.insert(user).values({
    id: "legal-user",
    name: "Legal Test",
    email: "legal@example.com",
    emailVerified: true,
    createdAt: new Date("2026-08-08T00:00:00Z"),
    updatedAt: new Date("2026-08-08T00:00:00Z"),
  });
  const [subject] = await database.db
    .insert(accountSubjects)
    .values({ authUserId: "legal-user" })
    .returning();
  if (!subject) throw new Error("subject insert failed");

  const input = {
    subjectId: subject.id,
    document: "terms" as const,
    version: "v1",
    source: "signup",
    acceptedAt: new Date("2026-08-08T01:00:00Z"),
  };

  await recordLegalAcceptance(input, database.db);
  await recordLegalAcceptance(input, database.db);

  const rows = await database.db
    .select()
    .from(legalAcceptances)
    .where(eq(legalAcceptances.subjectId, subject.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ documentKey: "terms", version: "v1", source: "signup" });
});
