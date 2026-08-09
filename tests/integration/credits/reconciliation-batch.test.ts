import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { grantCredits } from "@/platform/credits/application/credit-service";
import { reconcileCreditLedgerBatch } from "@/platform/credits/application/reconcile-credit-ledger";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  creditGrants,
  creditLedgerEntries,
  platformMeta,
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

beforeEach(async () => {
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

async function createSubject(): Promise<string> {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  return subject.id;
}

async function createGrant(subjectId: string, suffix: string) {
  return grantCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: 3,
    source: { type: "promotion", id: `batch-${suffix}` },
    idempotencyKey: `batch-grant-${suffix}`,
    expiresAt: null,
    actor: "system",
  });
}

it("limits one scan and eventually reaches grants after the cursor advances", async () => {
  const subjectId = await createSubject();
  await createGrant(subjectId, "one");
  await createGrant(subjectId, "two");
  await createGrant(subjectId, "three");

  const first = await reconcileCreditLedgerBatch(database.db, { limit: 2 });
  expect(first.processed).toBe(2);
  expect(first.processedEntities).toHaveLength(2);
  expect(first.issues).toEqual([]);

  const grants = await database.db
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .orderBy(creditGrants.id);
  const processedIds = new Set(
    first.processedEntities.filter((entity) => entity.kind === "grant").map((entity) => entity.id),
  );
  const laterGrant = grants.find((grant) => !processedIds.has(grant.id));
  if (!laterGrant) throw new Error("later grant was not found");

  await database.db
    .update(creditLedgerEntries)
    .set({ quantity: 2 })
    .where(
      and(
        eq(creditLedgerEntries.grantId, laterGrant.id),
        eq(creditLedgerEntries.entryType, "grant"),
      ),
    );

  const second = await reconcileCreditLedgerBatch(database.db, { limit: 2 });
  expect(second.processed).toBe(1);
  expect(second.processedEntities).toEqual([{ kind: "grant", id: laterGrant.id }]);
  expect(second.issues).toEqual([
    expect.objectContaining({ code: "GRANT_LEDGER_MISMATCH", entityId: laterGrant.id }),
  ]);
  expect(second.cycleComplete).toBe(true);
});

it("does not advance its checkpoint after an aborted batch", async () => {
  const subjectId = await createSubject();
  await createGrant(subjectId, "aborted");
  const controller = new AbortController();
  controller.abort();

  await expect(
    reconcileCreditLedgerBatch(database.db, { limit: 1, signal: controller.signal }),
  ).rejects.toThrow("credit reconciliation batch aborted");

  await expect(database.db.select().from(platformMeta)).resolves.toEqual([]);
});

it("stops the batch when its remaining runtime budget is exhausted", async () => {
  const subjectId = await createSubject();
  await createGrant(subjectId, "budget-one");
  await createGrant(subjectId, "budget-two");
  await createGrant(subjectId, "budget-three");
  let budgetChecks = 0;

  await expect(
    reconcileCreditLedgerBatch(database.db, {
      limit: 3,
      canContinue: () => {
        budgetChecks += 1;
        return budgetChecks < 4;
      },
    }),
  ).rejects.toThrow("credit reconciliation batch budget exhausted");

  expect(budgetChecks).toBeGreaterThan(1);
  await expect(database.db.select().from(platformMeta)).resolves.toEqual([]);
});

it("serializes concurrent batches and assigns distinct keyset rows", async () => {
  const subjectId = await createSubject();
  await createGrant(subjectId, "concurrent-one");
  await createGrant(subjectId, "concurrent-two");
  await createGrant(subjectId, "concurrent-three");

  const results = await Promise.all([
    reconcileCreditLedgerBatch(database.db, { limit: 1 }),
    reconcileCreditLedgerBatch(database.db, { limit: 1 }),
  ]);
  const processed = results.flatMap((result) => result.processedEntities);
  expect(processed).toHaveLength(2);
  expect(new Set(processed.map((entity) => `${entity.kind}:${entity.id}`)).size).toBe(2);
});
