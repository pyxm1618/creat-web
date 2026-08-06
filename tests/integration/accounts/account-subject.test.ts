import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createPostgresAccountSubjectRepository } from "@/platform/accounts/postgres-account-subject-repository";
import { createDatabaseClient } from "@/platform/database/client";
import { accountSubjects, user } from "@/platform/database/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const database = createDatabaseClient(databaseUrl);
const repository = createPostgresAccountSubjectRepository(database.db);

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

async function createAuthUser(id: string, email: string) {
  await database.db.insert(user).values({
    id,
    name: "Test User",
    email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("retained account subjects", () => {
  it("concurrent ensure calls create exactly one subject", async () => {
    await createAuthUser("user_concurrent", "concurrent@example.com");

    const subjects = await Promise.all(
      Array.from({ length: 8 }, () => repository.ensureForAuthUser("user_concurrent")),
    );

    expect(new Set(subjects.map((subject) => subject.id)).size).toBe(1);
    const rows = await database.db
      .select()
      .from(accountSubjects)
      .where(eq(accountSubjects.authUserId, "user_concurrent"));
    expect(rows).toHaveLength(1);
  });

  it("detaches identity and preserves the retained subject after hard user deletion", async () => {
    await createAuthUser("user_delete", "delete@example.com");
    const subject = await repository.ensureForAuthUser("user_delete");

    await repository.beginDeletion(subject.id);
    await repository.detachAuthIdentity(subject.id, "user_delete");
    await database.db.delete(user).where(eq(user.id, "user_delete"));
    const completed = await repository.completeDeletion(subject.id);

    expect(completed.status).toBe("deleted");
    expect(completed.authUserId).toBeNull();
    const retained = await database.db
      .select()
      .from(accountSubjects)
      .where(eq(accountSubjects.id, subject.id));
    expect(retained).toHaveLength(1);
  });
});
