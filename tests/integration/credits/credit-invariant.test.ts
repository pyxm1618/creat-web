import { afterAll, beforeAll, expect, it } from "vitest";

import {
  commitReservation,
  expireGrants,
  getGrantQuantityProjections,
  releaseReservation,
  reserveCredits,
} from "@/platform/credits/application/credit-service";

import {
  createCreditSubject,
  createCreditTestDatabase,
  createExpiringGrant,
  resetCreditTestDatabase,
} from "./credit-test-helpers";

const database = createCreditTestDatabase();

beforeAll(async () => resetCreditTestDatabase(database.db));
afterAll(async () => database.close());

function expectConserved(
  projections: Awaited<ReturnType<typeof getGrantQuantityProjections>>,
): void {
  for (const projection of projections) {
    expect(
      projection.consumed +
        projection.revoked +
        projection.expired +
        projection.activeReserved +
        projection.available,
    ).toBe(projection.quantity);
  }
}

it("conserves quantity through reserve, expiry, commit, and release transitions", async () => {
  const subjectId = await createCreditSubject(database.db);
  await createExpiringGrant(database.db, {
    subjectId,
    quantity: 10,
    expiresAt: new Date("2026-08-09T18:00:00Z"),
  });

  const first = await reserveCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: 4,
    purpose: { type: "analysis", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date("2026-08-09T18:30:00Z"),
    now: new Date("2026-08-09T17:59:00Z"),
  });
  const second = await reserveCredits(database.db, {
    subjectId,
    creditType: "reading",
    quantity: 3,
    purpose: { type: "analysis", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date("2026-08-09T18:30:00Z"),
    now: new Date("2026-08-09T17:59:00Z"),
  });
  expectConserved(await getGrantQuantityProjections(database.db, { subjectId, creditType: "reading" }));

  const afterExpiry = new Date("2026-08-09T18:01:00Z");
  await expireGrants(database.db, { now: afterExpiry });
  expectConserved(await getGrantQuantityProjections(database.db, { subjectId, creditType: "reading" }));

  await commitReservation(database.db, {
    reservationId: first.id,
    correlationId: "invariant-commit",
    now: afterExpiry,
  });
  await releaseReservation(database.db, {
    reservationId: second.id,
    correlationId: "invariant-release",
    reason: "delivery_failed",
    now: afterExpiry,
  });

  const final = await getGrantQuantityProjections(database.db, {
    subjectId,
    creditType: "reading",
  });
  expectConserved(final);
  expect(final).toEqual([
    {
      grantId: final[0]?.grantId,
      quantity: 10,
      consumed: 4,
      revoked: 0,
      expired: 6,
      activeReserved: 0,
      available: 0,
    },
  ]);
});
