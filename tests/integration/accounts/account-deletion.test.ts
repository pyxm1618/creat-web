import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createAccountDeletionService } from "@/platform/accounts/account-deletion-service";
import { createPostgresAccountSubjectRepository } from "@/platform/accounts/postgres-account-subject-repository";
import { createDatabaseClient } from "@/platform/database/client";
import {
  account,
  accountDeletionRequests,
  accountSubjects,
  session,
  user,
} from "@/platform/database/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const database = createDatabaseClient(databaseUrl);
const subjects = createPostgresAccountSubjectRepository(database.db);

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

async function seedIdentity(id: string) {
  const now = new Date();
  await database.db.insert(user).values({
    id,
    name: "Delete Test",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await database.db.insert(session).values({
    id: `session_${id}`,
    token: `token_${id}`,
    userId: id,
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now,
  });
  await database.db.insert(account).values({
    id: `account_${id}`,
    accountId: `provider_${id}`,
    providerId: "google",
    userId: id,
    createdAt: now,
    updatedAt: now,
  });
  return subjects.ensureForAuthUser(id);
}

describe("account deletion workflow", () => {
  it("hard deletes Better Auth identity while retaining a pseudonymous subject", async () => {
    const subject = await seedIdentity("delete_success");
    const service = createAccountDeletionService({
      database: database.db,
      subjects,
      coordinator: { prepare: async () => undefined },
    });

    const request = await service.request({
      subjectId: subject.id,
      authUserId: "delete_success",
    });
    const completed = await service.run(request.id);

    expect(completed.status).toBe("completed");
    expect(await database.db.select().from(user).where(eq(user.id, "delete_success"))).toEqual([]);
    expect(
      await database.db.select().from(session).where(eq(session.userId, "delete_success")),
    ).toEqual([]);
    expect(
      await database.db.select().from(account).where(eq(account.userId, "delete_success")),
    ).toEqual([]);

    const retained = await database.db
      .select()
      .from(accountSubjects)
      .where(eq(accountSubjects.id, subject.id));
    expect(retained[0]).toMatchObject({ status: "deleted", authUserId: null });
  });

  it("keeps a failed request retryable and resumes from its durable step", async () => {
    const subject = await seedIdentity("delete_retry");
    let attempts = 0;
    const service = createAccountDeletionService({
      database: database.db,
      subjects,
      coordinator: {
        prepare: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary downstream failure");
        },
      },
    });

    const first = await service.request({
      subjectId: subject.id,
      authUserId: "delete_retry",
    });
    await expect(service.run(first.id)).rejects.toThrow("account deletion failed");

    const failedRows = await database.db
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, first.id));
    expect(failedRows[0]).toMatchObject({
      status: "failed",
      step: "access_revoked",
      attempts: 1,
    });
    expect(
      await database.db.select().from(session).where(eq(session.userId, "delete_retry")),
    ).toEqual([]);
    expect(await database.db.select().from(user).where(eq(user.id, "delete_retry"))).toHaveLength(1);

    const completed = await service.run(first.id);
    expect(completed.status).toBe("completed");
    expect(completed.attempts).toBe(2);
  });
});
