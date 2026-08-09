import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import {
  commitReservation,
  expireGrants,
  getCreditBalance,
  releaseReservation,
  reserveCredits,
} from "@/platform/credits/application/credit-service";
import { creditGrants, creditLedgerEntries } from "@/platform/database/schema";

import {
  createCreditSubject,
  createCreditTestDatabase,
  createExpiringGrant,
  resetCreditTestDatabase,
} from "./credit-test-helpers";

const database = createCreditTestDatabase();

beforeAll(async () => resetCreditTestDatabase(database.db));
afterAll(async () => database.close());

it("commits a reservation after its source grant expires", async () => {
  const subjectId = await createCreditSubject(database.db);
  const grant = await createExpiringGrant(database.db, {
    subjectId,
    quantity: 5,
    expiresAt: new Date("2026-08-09T10:00:00Z"),
  });
  const reservation = await reserveCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: 3,
    purpose: { type: "analysis", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date("2026-08-09T10:30:00Z"),
    now: new Date("2026-08-09T09:59:00Z"),
  });

  await expireGrants(database.db, { now: new Date("2026-08-09T10:01:00Z") });
  expect(
    await getCreditBalance(database.db, {
      subjectId,
      creditType: "reading",
      now: new Date("2026-08-09T10:01:00Z"),
    }),
  ).toEqual({ available: 0, reserved: 3, consumed: 0, expired: 2, revoked: 0 });

  await commitReservation(database.db, {
    reservationId: reservation.id,
    correlationId: "delivery-after-grant-expiry",
    now: new Date("2026-08-09T10:02:00Z"),
  });

  expect(
    await getCreditBalance(database.db, {
      subjectId,
      creditType: "reading",
      now: new Date("2026-08-09T10:02:00Z"),
    }),
  ).toEqual({ available: 0, reserved: 0, consumed: 3, expired: 2, revoked: 0 });
  await expect(
    database.db.query.creditGrants.findFirst({ where: eq(creditGrants.id, grant.id) }),
  ).resolves.toMatchObject({ state: "expired" });
});

it("immediately expires released allocation after source expiry", async () => {
  const subjectId = await createCreditSubject(database.db);
  const grant = await createExpiringGrant(database.db, {
    subjectId,
    quantity: 5,
    expiresAt: new Date("2026-08-09T11:00:00Z"),
  });
  const reservation = await reserveCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: 3,
    purpose: { type: "analysis", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date("2026-08-09T11:30:00Z"),
    now: new Date("2026-08-09T10:59:00Z"),
  });

  await expireGrants(database.db, { now: new Date("2026-08-09T11:01:00Z") });
  await releaseReservation(database.db, {
    reservationId: reservation.id,
    correlationId: "release-after-grant-expiry",
    reason: "delivery_failed",
    now: new Date("2026-08-09T11:02:00Z"),
  });

  expect(
    await getCreditBalance(database.db, {
      subjectId,
      creditType: "reading",
      now: new Date("2026-08-09T11:02:00Z"),
    }),
  ).toEqual({ available: 0, reserved: 0, consumed: 0, expired: 5, revoked: 0 });

  const expiries = await database.db
    .select({ quantity: creditLedgerEntries.quantity })
    .from(creditLedgerEntries)
    .where(
      and(eq(creditLedgerEntries.grantId, grant.id), eq(creditLedgerEntries.entryType, "expire")),
    );
  expect(expiries.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(5);
});

it("rejects reserving a grant at its exact expiry timestamp", async () => {
  const subjectId = await createCreditSubject(database.db);
  await createExpiringGrant(database.db, {
    subjectId,
    quantity: 2,
    expiresAt: new Date("2026-08-09T12:00:00Z"),
  });

  await expect(
    reserveCredits(database.db, {
      subjectId,
      creditType: "reading",
      quantity: 1,
      purpose: { type: "analysis", id: crypto.randomUUID() },
      idempotencyKey: `reserve-${crypto.randomUUID()}`,
      expiresAt: new Date("2026-08-09T12:30:00Z"),
      now: new Date("2026-08-09T12:00:00Z"),
    }),
  ).rejects.toThrow();

  const totals = await database.db.execute<{ total: number }>(sql`
    select coalesce(sum(quantity), 0)::int as total
    from credit_reservation_allocations
  `);
  expect(Number(totals[0]?.total ?? 0)).toBe(0);
});
