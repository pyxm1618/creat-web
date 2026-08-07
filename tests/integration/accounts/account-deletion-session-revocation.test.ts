import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createBetterAuthIdentityDeletion } from "@/platform/accounts/better-auth-identity-deletion";
import { createDatabaseClient } from "@/platform/database/client";
import { session, user } from "@/platform/database/schema";

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

describe("account deletion session revocation", () => {
  it("invalidates every browser token and leaves one private worker session", async () => {
    const authUserId = "delete_session_user";
    const now = new Date();
    await database.db.insert(user).values({
      id: authUserId,
      name: "Delete Session",
      email: "delete-session@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await database.db.insert(session).values([
      {
        id: "browser_session_one",
        token: `browser-one-${"a".repeat(32)}`,
        userId: authUserId,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
        userAgent: "browser-one",
      },
      {
        id: "browser_session_two",
        token: `browser-two-${"b".repeat(32)}`,
        userId: authUserId,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
        userAgent: "browser-two",
      },
    ]);

    const deletion = createBetterAuthIdentityDeletion({
      database: database.db,
      invokeDeleteUser: async () => new Response(null, { status: 500 }),
    });
    await deletion.prepareForDeletion?.(authUserId);

    const remaining = await database.db
      .select()
      .from(session)
      .where(eq(session.userId, authUserId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.userAgent).toBe("creat-web-account-deletion-worker");
    expect(remaining[0]?.token).not.toContain("browser-one");
    expect(remaining[0]?.token).not.toContain("browser-two");
  });
});
