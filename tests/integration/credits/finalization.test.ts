import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { getCreditBalance, grantCredits } from "@/platform/credits/application/credit-service";
import { executeCreditBackedWork } from "@/platform/credits/application/execute-credit-backed-work";
import { runCreditFinalizationWorker } from "@/platform/credits/application/finalization-worker";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  creditFinalizationJobs,
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

it("does not redo or release delivered work when credit commit temporarily fails", async () => {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject fixture failed");
  await grantCredits(database.db, {
    subjectId: subject.id,
    creditType: "reading",
    quantity: 1,
    source: { type: "promotion", id: `promo-${crypto.randomUUID()}` },
    idempotencyKey: `grant-${crypto.randomUUID()}`,
    expiresAt: null,
    actor: "system",
  });

  let workCalls = 0;
  let persistCalls = 0;
  const result = await executeCreditBackedWork(
    database.db,
    {
      subjectId: subject.id,
      creditType: "reading",
      quantity: 1,
      purpose: { type: "reading", id: crypto.randomUUID() },
      idempotencyKey: `reserve-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    },
    {
      async work() {
        workCalls += 1;
        return { text: "durably delivered" };
      },
      async persistDelivery() {
        persistCalls += 1;
        return { deliveryReference: `delivery-${crypto.randomUUID()}` };
      },
      async finalize() {
        throw new Error("injected post-delivery commit outage");
      },
    },
  );

  expect(result.finalizationPending).toBe(true);
  expect(workCalls).toBe(1);
  expect(persistCalls).toBe(1);
  const job = await database.db.query.creditFinalizationJobs.findFirst({
    where: eq(creditFinalizationJobs.deliveryReference, result.deliveryReference),
  });
  expect(job).toMatchObject({ state: "pending" });
  const reservation = await database.db.query.creditReservations.findFirst({
    where: eq(creditReservations.id, job?.reservationId ?? "00000000-0000-0000-0000-000000000000"),
  });
  expect(reservation?.status).toBe("active");
  expect(
    await getCreditBalance(database.db, { subjectId: subject.id, creditType: "reading" }),
  ).toMatchObject({ available: 0, reserved: 1, consumed: 0 });

  const worker = await runCreditFinalizationWorker(database.db, { owner: "recovery-worker" });
  expect(worker.completed).toBe(1);
  expect(
    await getCreditBalance(database.db, { subjectId: subject.id, creditType: "reading" }),
  ).toMatchObject({ available: 0, reserved: 0, consumed: 1 });
  expect(workCalls).toBe(1);
  expect(persistCalls).toBe(1);
});
