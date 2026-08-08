import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { grantCredits, reserveCredits } from "@/platform/credits/application/credit-service";
import { reconcileCreditLedger } from "@/platform/credits/application/reconcile-credit-ledger";
import { createDatabaseClient } from "@/platform/database/client";
import { accountSubjects, creditReservationAllocations } from "@/platform/database/schema";

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

it("reports no issues for a coherent active ledger", async () => {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  await grantCredits(database.db, {
    subjectId: subject.id,
    creditType: "reading",
    quantity: 3,
    source: { type: "promotion", id: `promo-${crypto.randomUUID()}` },
    idempotencyKey: `grant-${crypto.randomUUID()}`,
    expiresAt: null,
    actor: "system",
  });
  await reserveCredits(database.db, {
    subjectId: subject.id,
    creditType: "reading",
    quantity: 1,
    purpose: { type: "analysis", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date("2026-08-08T14:00:00Z"),
    now: new Date("2026-08-08T13:00:00Z"),
  });
  expect(await reconcileCreditLedger(database.db, { now: new Date("2026-08-08T13:30:00Z") })).toEqual([]);
});

it("detects allocation corruption without repairing it silently", async () => {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  await grantCredits(database.db, {
    subjectId: subject.id,
    creditType: "reading",
    quantity: 2,
    source: { type: "promotion", id: `promo-${crypto.randomUUID()}` },
    idempotencyKey: `grant-${crypto.randomUUID()}`,
    expiresAt: null,
    actor: "system",
  });
  const reservation = await reserveCredits(database.db, {
    subjectId: subject.id,
    creditType: "reading",
    quantity: 1,
    purpose: { type: "analysis", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date("2026-08-08T16:00:00Z"),
    now: new Date("2026-08-08T15:00:00Z"),
  });
  await database.db
    .update(creditReservationAllocations)
    .set({ quantity: 2 })
    .where(sql`${creditReservationAllocations.reservationId} = ${reservation.id}::uuid`);

  const issues = await reconcileCreditLedger(database.db, { now: new Date("2026-08-08T15:30:00Z") });
  expect(issues.some((issue) => issue.code === "RESERVATION_ALLOCATION_MISMATCH")).toBe(true);
});
