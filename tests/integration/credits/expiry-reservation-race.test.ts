import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  commitReservation,
  expireGrants,
  expireReservations,
  getCreditBalance,
  releaseReservation,
  reserveCredits,
} from "@/platform/credits/application/credit-service";
import { creditLedgerEntries, creditReservations } from "@/platform/database/schema";

import {
  createCreditSubject,
  createCreditTestDatabase,
  createExpiringGrant,
  resetCreditTestDatabase,
} from "./credit-test-helpers";

const database = createCreditTestDatabase();

beforeAll(async () => resetCreditTestDatabase(database.db));
afterAll(async () => database.close());

async function setupReservedGrant(input: {
  grantExpiry: string;
  reservationExpiry: string;
  quantity?: number;
  reserved?: number;
}) {
  const subjectId = await createCreditSubject(database.db);
  const grant = await createExpiringGrant(database.db, {
    subjectId,
    quantity: input.quantity ?? 5,
    expiresAt: new Date(input.grantExpiry),
  });
  const reservation = await reserveCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: input.reserved ?? 3,
    purpose: { type: "analysis", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date(input.reservationExpiry),
    now: new Date(new Date(input.grantExpiry).getTime() - 60_000),
  });
  return { subjectId, grant, reservation };
}

it("serializes grant expiry racing a commit", async () => {
  const { subjectId, reservation } = await setupReservedGrant({
    grantExpiry: "2026-08-09T13:00:00Z",
    reservationExpiry: "2026-08-09T13:30:00Z",
  });
  const now = new Date("2026-08-09T13:01:00Z");

  await Promise.all([
    expireGrants(database.db, { now }),
    commitReservation(database.db, {
      reservationId: reservation.id,
      correlationId: "race-commit",
      now,
    }),
  ]);

  expect(await getCreditBalance(database.db, { subjectId, creditType: "reading", now })).toEqual({
    available: 0,
    reserved: 0,
    consumed: 3,
    expired: 2,
    revoked: 0,
  });
});

it("serializes grant expiry racing a release without restoring spendable credits", async () => {
  const { subjectId, reservation } = await setupReservedGrant({
    grantExpiry: "2026-08-09T14:00:00Z",
    reservationExpiry: "2026-08-09T14:30:00Z",
  });
  const now = new Date("2026-08-09T14:01:00Z");

  await Promise.all([
    expireGrants(database.db, { now }),
    releaseReservation(database.db, {
      reservationId: reservation.id,
      correlationId: "race-release",
      reason: "delivery_failed",
      now,
    }),
  ]);

  expect(await getCreditBalance(database.db, { subjectId, creditType: "reading", now })).toEqual({
    available: 0,
    reserved: 0,
    consumed: 0,
    expired: 5,
    revoked: 0,
  });
});

it("serializes stale reservation expiry against source grant expiry", async () => {
  const { subjectId, reservation } = await setupReservedGrant({
    grantExpiry: "2026-08-09T15:00:00Z",
    reservationExpiry: "2026-08-09T15:00:00Z",
  });
  const now = new Date("2026-08-09T15:01:00Z");

  await Promise.all([expireGrants(database.db, { now }), expireReservations(database.db, { now })]);

  expect(await getCreditBalance(database.db, { subjectId, creditType: "reading", now })).toEqual({
    available: 0,
    reserved: 0,
    consumed: 0,
    expired: 5,
    revoked: 0,
  });
  await expect(
    database.db.query.creditReservations.findFirst({
      where: eq(creditReservations.id, reservation.id),
    }),
  ).resolves.toMatchObject({ status: "expired" });
});

it("keeps two concurrent grant expiry workers idempotent", async () => {
  const subjectId = await createCreditSubject(database.db);
  const grant = await createExpiringGrant(database.db, {
    subjectId,
    quantity: 5,
    expiresAt: new Date("2026-08-09T16:00:00Z"),
  });
  const now = new Date("2026-08-09T16:01:00Z");

  await Promise.all([
    expireGrants(database.db, { now, limit: 100 }),
    expireGrants(database.db, { now, limit: 100 }),
  ]);

  const expiryRows = await database.db
    .select({ quantity: creditLedgerEntries.quantity })
    .from(creditLedgerEntries)
    .where(
      and(eq(creditLedgerEntries.grantId, grant.id), eq(creditLedgerEntries.entryType, "expire")),
    );
  expect(expiryRows).toEqual([{ quantity: 5 }]);
});

it("replays terminal operations without duplicate ledger effects", async () => {
  const { subjectId, reservation } = await setupReservedGrant({
    grantExpiry: "2026-08-09T17:00:00Z",
    reservationExpiry: "2026-08-09T17:30:00Z",
  });
  const now = new Date("2026-08-09T17:01:00Z");

  await expireGrants(database.db, { now });
  await commitReservation(database.db, {
    reservationId: reservation.id,
    correlationId: "replay-commit",
    now,
  });
  await commitReservation(database.db, {
    reservationId: reservation.id,
    correlationId: "replay-commit",
    now,
  });
  await expireGrants(database.db, { now });

  expect(await getCreditBalance(database.db, { subjectId, creditType: "reading", now })).toEqual({
    available: 0,
    reserved: 0,
    consumed: 3,
    expired: 2,
    revoked: 0,
  });
});
