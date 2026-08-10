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
  creditReconciliationIncidents,
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

async function mutateLedgerQuantity(grantId: string, quantity: number): Promise<void> {
  await database.db.execute(
    sql.raw(
      'ALTER TABLE "credit_ledger_entries" DISABLE TRIGGER "credit_ledger_entries_append_only"',
    ),
  );
  try {
    await database.db
      .update(creditLedgerEntries)
      .set({ quantity })
      .where(
        and(eq(creditLedgerEntries.grantId, grantId), eq(creditLedgerEntries.entryType, "grant")),
      );
  } finally {
    await database.db.execute(
      sql.raw(
        'ALTER TABLE "credit_ledger_entries" ENABLE TRIGGER "credit_ledger_entries_append_only"',
      ),
    );
  }
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

  await mutateLedgerQuantity(laterGrant.id, 2);

  const second = await reconcileCreditLedgerBatch(database.db, { limit: 2 });
  expect(second.processed).toBe(1);
  expect(second.processedEntities).toEqual([{ kind: "grant", id: laterGrant.id }]);
  expect(second.issues).toEqual([
    expect.objectContaining({ code: "GRANT_LEDGER_MISMATCH", entityId: laterGrant.id }),
  ]);
  expect(second.cycleComplete).toBe(true);
});

it("persists, increments, and resolves reconciliation incidents", async () => {
  const subjectId = await createSubject();
  const grant = await createGrant(subjectId, "durable-incident");
  const firstDetectedAt = new Date("2026-08-10T01:00:00Z");
  const detectedAgainAt = new Date("2026-08-10T01:05:00Z");
  const resolvedAt = new Date("2026-08-10T01:10:00Z");

  await mutateLedgerQuantity(grant.id, 2);
  const first = await reconcileCreditLedgerBatch(database.db, {
    limit: 10,
    now: firstDetectedAt,
  });
  expect(first.issues).toContainEqual(
    expect.objectContaining({ code: "GRANT_LEDGER_MISMATCH", entityId: grant.id }),
  );

  const second = await reconcileCreditLedgerBatch(database.db, {
    limit: 10,
    now: detectedAgainAt,
  });
  expect(second.issues).toContainEqual(
    expect.objectContaining({ code: "GRANT_LEDGER_MISMATCH", entityId: grant.id }),
  );
  const open = await database.db
    .select()
    .from(creditReconciliationIncidents)
    .where(
      and(
        eq(creditReconciliationIncidents.code, "GRANT_LEDGER_MISMATCH"),
        eq(creditReconciliationIncidents.entityId, grant.id),
      ),
    );
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({
    status: "open",
    occurrences: 2,
    firstDetectedAt,
    lastDetectedAt: detectedAgainAt,
    resolvedAt: null,
  });

  await mutateLedgerQuantity(grant.id, 3);
  const repaired = await reconcileCreditLedgerBatch(database.db, { limit: 10, now: resolvedAt });
  expect(repaired.issues).not.toContainEqual(
    expect.objectContaining({ code: "GRANT_LEDGER_MISMATCH", entityId: grant.id }),
  );
  const [resolved] = await database.db
    .select()
    .from(creditReconciliationIncidents)
    .where(
      and(
        eq(creditReconciliationIncidents.code, "GRANT_LEDGER_MISMATCH"),
        eq(creditReconciliationIncidents.entityId, grant.id),
      ),
    );
  expect(resolved).toMatchObject({
    status: "resolved",
    occurrences: 2,
    firstDetectedAt,
    lastDetectedAt: detectedAgainAt,
    resolvedAt,
  });
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
