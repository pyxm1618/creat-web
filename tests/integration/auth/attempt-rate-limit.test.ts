import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createAuthAttemptLimiter } from "@/platform/auth/attempt-rate-limit";
import { createDatabaseClient } from "@/platform/database/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const database = createDatabaseClient(databaseUrl);
const limiter = createAuthAttemptLimiter(database.db, "test-rate-limit-secret".repeat(3));

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

describe("durable auth attempt limiter", () => {
  it("allows the configured number of attempts and rejects the next one", async () => {
    const input = {
      scope: "magic-link-confirm",
      identifiers: ["ip:203.0.113.7", "token:token-a"],
      windowMs: 60_000,
      max: 2,
      now: new Date("2026-08-06T12:00:00Z"),
    } as const;

    await expect(limiter.consume(input)).resolves.toBeUndefined();
    await expect(limiter.consume(input)).resolves.toBeUndefined();
    await expect(limiter.consume(input)).rejects.toThrow("authentication attempt rate limited");
  });

  it("is safe across concurrent simulated instances", async () => {
    const other = createAuthAttemptLimiter(database.db, "test-rate-limit-secret".repeat(3));
    const input = {
      scope: "magic-link-confirm",
      identifiers: ["token:token-concurrent"],
      windowMs: 60_000,
      max: 3,
      now: new Date("2026-08-06T12:01:00Z"),
    } as const;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? limiter : other).consume(input)),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(5);
  });

  it("starts a new counter after the window expires", async () => {
    const base = {
      scope: "magic-link-confirm",
      identifiers: ["token:token-window"],
      windowMs: 1_000,
      max: 1,
    } as const;

    await limiter.consume({ ...base, now: new Date("2026-08-06T12:02:00Z") });
    await expect(
      limiter.consume({ ...base, now: new Date("2026-08-06T12:02:02Z") }),
    ).resolves.toBeUndefined();
  });

  it("keeps a fixed window start instead of extending it on each allowed request", async () => {
    const base = {
      scope: "magic-link-send-daily",
      identifiers: ["email:fixed-window@example.com"],
      windowMs: 10_000,
      max: 2,
    } as const;

    await limiter.consume({ ...base, now: new Date("2026-08-06T12:03:00.000Z") });
    await limiter.consume({ ...base, now: new Date("2026-08-06T12:03:09.000Z") });
    await expect(
      limiter.consume({ ...base, now: new Date("2026-08-06T12:03:11.000Z") }),
    ).resolves.toBeUndefined();
  });
});
