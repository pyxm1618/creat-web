import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createAccountDeletionService } from "@/platform/accounts/account-deletion-service";
import { createPostgresAccountSubjectRepository } from "@/platform/accounts/postgres-account-subject-repository";
import { createDatabaseClient } from "@/platform/database/client";
import { accountDeletionRequests, user } from "@/platform/database/schema";

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

describe("durable account deletion worker", () => {
  it("claims a failed due job and completes it without another user request", async () => {
    const authUserId = "worker_retry_user";
    const timestamp = new Date();
    await database.db.insert(user).values({
      id: authUserId,
      name: "Worker Retry",
      email: "worker-retry@example.com",
      emailVerified: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const subject = await subjects.ensureForAuthUser(authUserId);

    let prepareCalls = 0;
    let clock = new Date("2030-08-07T04:00:00Z").getTime();
    const service = createAccountDeletionService({
      database: database.db,
      subjects,
      coordinator: {
        prepare: async () => {
          prepareCalls += 1;
          if (prepareCalls === 1) throw new Error("temporary dependency failure");
        },
      },
      identityDeletion: {
        deleteUser: async (userId) => {
          await database.db.delete(user).where(eq(user.id, userId));
        },
      },
      now: () => new Date((clock += 60_000)),
    });

    const request = await service.request({ subjectId: subject.id, authUserId });
    await expect(service.run(request.id)).rejects.toThrow("account deletion failed");

    const result = await service.runDueBatch(5);
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(prepareCalls).toBe(2);

    const rows = await database.db
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, request.id));
    expect(rows[0]?.status).toBe("completed");
  });
});
