import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  creditGrants,
  creditLedgerEntries,
  creditReservations,
} from "@/platform/database/schema";

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

afterAll(async () => database.close());

async function createSubjectId() {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  return subject.id;
}

async function expectAppendOnlyRejection(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error("ledger mutation unexpectedly succeeded");
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain("credit ledger entries are append only");
  }
}

it("rejects duplicate grant sources and non-positive quantities", async () => {
  const subjectId = await createSubjectId();
  const sourceId = `src-${crypto.randomUUID()}`;
  await database.db.insert(creditGrants).values({
    subjectId,
    creditType: "reading",
    sourceType: "promotion",
    sourceId,
    quantity: 1,
    idempotencyKey: `grant-${crypto.randomUUID()}`,
  });
  await expect(
    database.db.insert(creditGrants).values({
      subjectId,
      creditType: "reading",
      sourceType: "promotion",
      sourceId,
      quantity: 1,
      idempotencyKey: `grant-${crypto.randomUUID()}`,
    }),
  ).rejects.toThrow();
  await expect(
    database.db.insert(creditGrants).values({
      subjectId,
      creditType: "reading",
      sourceType: "promotion",
      sourceId: `src-${crypto.randomUUID()}`,
      quantity: 0,
      idempotencyKey: `grant-${crypto.randomUUID()}`,
    }),
  ).rejects.toThrow();
});

it("rejects duplicate reservation purpose and invalid statuses", async () => {
  const subjectId = await createSubjectId();
  const purposeId = crypto.randomUUID();
  await database.db.insert(creditReservations).values({
    subjectId,
    creditType: "reading",
    purposeType: "analysis",
    purposeId,
    quantity: 1,
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await expect(
    database.db.insert(creditReservations).values({
      subjectId,
      creditType: "reading",
      purposeType: "analysis",
      purposeId,
      quantity: 1,
      idempotencyKey: `reserve-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  ).rejects.toThrow();
  await expect(
    database.db.insert(creditReservations).values({
      subjectId,
      creditType: "reading",
      purposeType: "analysis",
      purposeId: crypto.randomUUID(),
      quantity: 1,
      status: "invented",
      idempotencyKey: `reserve-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  ).rejects.toThrow();
});

it("rejects non-positive immutable ledger entries", async () => {
  const subjectId = await createSubjectId();
  await expect(
    database.db.insert(creditLedgerEntries).values({
      subjectId,
      creditType: "reading",
      entryType: "grant",
      quantity: 0,
      sourceType: "promotion",
      sourceId: "bad",
      correlationId: "bad",
      idempotencyKey: `bad-${crypto.randomUUID()}`,
      actorType: "system",
    }),
  ).rejects.toThrow();
  expect(
    await database.db
      .select()
      .from(creditLedgerEntries)
      .where(eq(creditLedgerEntries.sourceId, "bad")),
  ).toHaveLength(0);
});

it("rejects updates and deletes of persisted ledger entries", async () => {
  const subjectId = await createSubjectId();
  const [entry] = await database.db
    .insert(creditLedgerEntries)
    .values({
      subjectId,
      creditType: "reading",
      entryType: "grant",
      quantity: 1,
      sourceType: "promotion",
      sourceId: `immutable-${crypto.randomUUID()}`,
      correlationId: `immutable-${crypto.randomUUID()}`,
      idempotencyKey: `immutable-${crypto.randomUUID()}`,
      actorType: "system",
    })
    .returning();
  if (!entry) throw new Error("ledger entry insert failed");

  await expectAppendOnlyRejection(
    database.db
      .update(creditLedgerEntries)
      .set({ quantity: 2 })
      .where(eq(creditLedgerEntries.id, entry.id)),
  );
  await expectAppendOnlyRejection(
    database.db.delete(creditLedgerEntries).where(eq(creditLedgerEntries.id, entry.id)),
  );
});
