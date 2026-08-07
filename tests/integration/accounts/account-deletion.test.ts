import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createAccountDeletionService } from "@/platform/accounts/account-deletion-service";
import { createBetterAuthIdentityDeletion } from "@/platform/accounts/better-auth-identity-deletion";
import { createPostgresAccountSubjectRepository } from "@/platform/accounts/postgres-account-subject-repository";
import { createAuth } from "@/platform/auth/create-auth";
import { createDatabaseClient } from "@/platform/database/client";
import {
  account,
  accountDeletionRequests,
  accountSubjects,
  session,
  user,
} from "@/platform/database/schema";
import * as schema from "@/platform/database/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const database = createDatabaseClient(databaseUrl);
const subjects = createPostgresAccountSubjectRepository(database.db);
const testAuth = createAuth({
  appName: "creat-web-test",
  baseURL: "http://localhost:3000",
  secret: "integration-better-auth-secret-with-at-least-32-characters",
  cookiePrefix: "creat-web-test",
  database: database.db,
  schema,
  sendMagicLink: async () => undefined,
});
const betterAuthIdentityDeletion = createBetterAuthIdentityDeletion({
  database: database.db,
  invokeDeleteUser: (headers) => testAuth.api.deleteUser({ body: {}, headers, asResponse: true }),
});

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
    token: `token_${id}_${"x".repeat(32)}`,
    userId: id,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
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

function databaseIdentityDeletion() {
  return {
    deleteUser: async (authUserId: string) => {
      await database.db.delete(user).where(eq(user.id, authUserId));
    },
  };
}

describe("account deletion workflow", () => {
  it("uses Better Auth to hard delete identity while retaining the pseudonymous subject", async () => {
    const subject = await seedIdentity("delete_success");
    const service = createAccountDeletionService({
      database: database.db,
      subjects,
      coordinator: { prepare: async () => undefined },
      identityDeletion: betterAuthIdentityDeletion,
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

  it("keeps a failed downstream request durable and resumes without repeating completed steps", async () => {
    const subject = await seedIdentity("delete_retry");
    let prepareAttempts = 0;
    const service = createAccountDeletionService({
      database: database.db,
      subjects,
      coordinator: {
        prepare: async () => {
          prepareAttempts += 1;
          if (prepareAttempts === 1) throw new Error("temporary downstream failure");
        },
      },
      identityDeletion: databaseIdentityDeletion(),
      now: (() => {
        let value = new Date("2030-08-07T00:00:00Z").getTime();
        return () => new Date((value += 60_000));
      })(),
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
    expect(await database.db.select().from(user).where(eq(user.id, "delete_retry"))).toHaveLength(
      1,
    );

    const completed = await service.run(first.id);
    expect(completed.status).toBe("completed");
    expect(completed.attempts).toBe(2);
    expect(prepareAttempts).toBe(2);
  });

  it("allows only one concurrent worker to execute destructive steps", async () => {
    const subject = await seedIdentity("delete_concurrent");
    let prepareCalls = 0;
    let deleteCalls = 0;
    const service = createAccountDeletionService({
      database: database.db,
      subjects,
      coordinator: {
        prepare: async () => {
          prepareCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      },
      identityDeletion: {
        deleteUser: async (authUserId) => {
          deleteCalls += 1;
          await database.db.delete(user).where(eq(user.id, authUserId));
        },
      },
    });

    const request = await service.request({
      subjectId: subject.id,
      authUserId: "delete_concurrent",
    });
    await Promise.all(Array.from({ length: 8 }, () => service.run(request.id)));

    const rows = await database.db
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, request.id));
    expect(rows[0]?.status).toBe("completed");
    expect(prepareCalls).toBe(1);
    expect(deleteCalls).toBe(1);
  });

  it("resumes after an identity deletion failure without repeating downstream preparation", async () => {
    const subject = await seedIdentity("delete_identity_retry");
    let prepareCalls = 0;
    let deleteCalls = 0;
    const service = createAccountDeletionService({
      database: database.db,
      subjects,
      coordinator: {
        prepare: async () => {
          prepareCalls += 1;
        },
      },
      identityDeletion: {
        deleteUser: async (authUserId) => {
          deleteCalls += 1;
          if (deleteCalls === 1) throw new Error("temporary identity failure");
          await database.db.delete(user).where(eq(user.id, authUserId));
        },
      },
      now: (() => {
        let value = new Date("2030-08-07T02:00:00Z").getTime();
        return () => new Date((value += 60_000));
      })(),
    });

    const request = await service.request({
      subjectId: subject.id,
      authUserId: "delete_identity_retry",
    });
    await expect(service.run(request.id)).rejects.toThrow("account deletion failed");

    const failed = await database.db
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, request.id));
    expect(failed[0]).toMatchObject({ status: "failed", step: "identity_detached" });

    const completed = await service.run(request.id);
    expect(completed.status).toBe("completed");
    expect(prepareCalls).toBe(1);
    expect(deleteCalls).toBe(2);
  });
});
