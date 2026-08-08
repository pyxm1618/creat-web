import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  commitReservation,
  expireGrants,
  expireReservations,
  getCreditBalance,
  grantCredits,
  releaseReservation,
  reserveCredits,
  revokeSourceCredits,
} from "@/platform/credits/application/credit-service";
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

async function subject(): Promise<string> {
  const [row] = await database.db.insert(accountSubjects).values({}).returning();
  if (!row) throw new Error("subject insert failed");
  return row.id;
}

async function grant(subjectId: string, quantity: number, suffix = crypto.randomUUID()) {
  return grantCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity,
    source: { type: "promotion", id: `source-${suffix}` },
    idempotencyKey: `grant-${suffix}`,
    expiresAt: null,
    actor: "system",
  });
}

it("grants idempotently and projects balance from ledger state", async () => {
  const subjectId = await subject();
  const suffix = crypto.randomUUID();
  const first = await grant(subjectId, 5, suffix);
  const second = await grant(subjectId, 5, suffix);
  expect(second.id).toBe(first.id);
  expect(await getCreditBalance(database.db, { subjectId, creditType: "reading" })).toEqual({
    available: 5,
    reserved: 0,
    consumed: 0,
    expired: 0,
    revoked: 0,
  });
  const entries = await database.db
    .select()
    .from(creditLedgerEntries)
    .where(eq(creditLedgerEntries.grantId, first.id));
  expect(entries.filter((entry) => entry.entryType === "grant")).toHaveLength(1);
});

it("serializes competing reservations for the same subject and credit type", async () => {
  const subjectId = await subject();
  await grant(subjectId, 5);
  const now = new Date("2026-08-08T05:00:00Z");
  const expiresAt = new Date("2026-08-08T05:30:00Z");

  const results = await Promise.allSettled([
    reserveCredits(database.db, {
      subjectId,
      creditType: "reading",
      quantity: 4,
      purpose: { type: "analysis", id: `a-${crypto.randomUUID()}` },
      idempotencyKey: `reserve-${crypto.randomUUID()}`,
      expiresAt,
      now,
    }),
    reserveCredits(database.db, {
      subjectId,
      creditType: "reading",
      quantity: 4,
      purpose: { type: "analysis", id: `b-${crypto.randomUUID()}` },
      idempotencyKey: `reserve-${crypto.randomUUID()}`,
      expiresAt,
      now,
    }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(await getCreditBalance(database.db, { subjectId, creditType: "reading", now })).toEqual({
    available: 1,
    reserved: 4,
    consumed: 0,
    expired: 0,
    revoked: 0,
  });
});

it("commits and releases exact preserved allocations idempotently", async () => {
  const subjectId = await subject();
  await grant(subjectId, 6);
  const now = new Date("2026-08-08T06:00:00Z");
  const reservation = await reserveCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: 4,
    purpose: { type: "analysis", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date("2026-08-08T07:00:00Z"),
    now,
  });
  await commitReservation(database.db, {
    reservationId: reservation.id,
    correlationId: "delivery-1",
    now,
  });
  await commitReservation(database.db, {
    reservationId: reservation.id,
    correlationId: "delivery-1",
    now,
  });
  await expect(
    releaseReservation(database.db, {
      reservationId: reservation.id,
      correlationId: "release-after-commit",
      reason: "invalid",
      now,
    }),
  ).rejects.toThrow("invalid credit reservation transition");
  expect(await getCreditBalance(database.db, { subjectId, creditType: "reading", now })).toEqual({
    available: 2,
    reserved: 0,
    consumed: 4,
    expired: 0,
    revoked: 0,
  });
  const consumes = await database.db
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.reservationId, reservation.id),
        eq(creditLedgerEntries.entryType, "consume"),
      ),
    );
  expect(consumes.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(4);
});

it("expires stale reservations without consuming credits", async () => {
  const subjectId = await subject();
  await grant(subjectId, 3);
  const reservation = await reserveCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: 2,
    purpose: { type: "analysis", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date("2026-08-08T08:05:00Z"),
    now: new Date("2026-08-08T08:00:00Z"),
  });
  expect(
    await expireReservations(database.db, { now: new Date("2026-08-08T08:06:00Z") }),
  ).toBeGreaterThanOrEqual(1);
  const row = await database.db.query.creditReservations.findFirst({
    where: eq(creditReservations.id, reservation.id),
  });
  expect(row?.status).toBe("expired");
  expect(
    await getCreditBalance(database.db, {
      subjectId,
      creditType: "reading",
      now: new Date("2026-08-08T08:06:00Z"),
    }),
  ).toMatchObject({ available: 3, reserved: 0, consumed: 0 });
});

it("expires unused grants and revokes only unused source credits", async () => {
  const subjectId = await subject();
  const expiring = await grantCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: 2,
    source: { type: "promotion", id: `exp-${crypto.randomUUID()}` },
    idempotencyKey: `grant-${crypto.randomUUID()}`,
    expiresAt: new Date("2026-08-08T09:00:00Z"),
    actor: "system",
  });
  expect(
    await expireGrants(database.db, { now: new Date("2026-08-08T09:01:00Z") }),
  ).toBeGreaterThanOrEqual(1);
  expect(
    await database.db.query.creditGrants.findFirst({ where: eq(creditGrants.id, expiring.id) }),
  ).toMatchObject({ state: "expired" });

  const orderSource = `order-${crypto.randomUUID()}`;
  const orderGrant = await grantCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: 5,
    source: { type: "order", id: orderSource },
    idempotencyKey: `order-grant-${crypto.randomUUID()}`,
    expiresAt: null,
    actor: "system",
  });
  const reservation = await reserveCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: 2,
    purpose: { type: "analysis", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date("2026-08-09T10:00:00Z"),
    now: new Date("2026-08-08T10:00:00Z"),
  });
  await commitReservation(database.db, {
    reservationId: reservation.id,
    correlationId: `delivery-${crypto.randomUUID()}`,
  });
  const reversal = await revokeSourceCredits(database.db, {
    source: { type: "order", id: orderSource },
    correlationId: `refund-${crypto.randomUUID()}`,
  });
  expect(reversal.revoked).toBe(3);
  expect(reversal.blocked).toBeGreaterThanOrEqual(2);
  const grantRow = await database.db.query.creditGrants.findFirst({
    where: eq(creditGrants.id, orderGrant.id),
  });
  expect(grantRow).toBeTruthy();
});

it("requires an explicit reviewed policy for partial source reversal", async () => {
  await expect(
    revokeSourceCredits(database.db, {
      source: { type: "order", id: "irrelevant" },
      quantity: 1,
      correlationId: "partial-without-policy",
    }),
  ).rejects.toThrow("operator-reviewed policy");
});
