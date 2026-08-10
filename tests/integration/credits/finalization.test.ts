import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { getCreditBalance, grantCredits } from "@/platform/credits/application/credit-service";
import { executeCreditBackedWork } from "@/platform/credits/application/execute-credit-backed-work";
import { withCreditReservation } from "@/platform/credits/application/finalization-service";
import { runCreditFinalizationWorker } from "@/platform/credits/application/finalization-worker";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  creditFinalizationJobs,
  creditReservations,
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

afterAll(async () => database.close());

async function grantedSubject(): Promise<string> {
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
  return subject.id;
}

function reserveInput(subjectId: string) {
  return {
    subjectId,
    creditType: "reading",
    quantity: 1,
    purpose: { type: "reading", id: crypto.randomUUID() },
    idempotencyKey: `reserve-${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

it("rolls back delivery and finalization obligation when delivery persistence fails", async () => {
  const subjectId = await grantedSubject();
  const deliveryKey = `delivery:${crypto.randomUUID()}`;
  let reservationId: string | undefined;

  await expect(
    executeCreditBackedWork(database.db, reserveInput(subjectId), {
      work: async () => ({ text: "generated" }),
      persistDelivery: async (_result, reservation, tx) => {
        reservationId = reservation.id;
        await tx.insert(platformMeta).values({ key: deliveryKey, value: "stored" });
        throw new Error("delivery transaction failed");
      },
    }),
  ).rejects.toThrow("delivery transaction failed");

  expect(
    await database.db.select().from(platformMeta).where(eq(platformMeta.key, deliveryKey)),
  ).toHaveLength(0);
  expect(
    await database.db
      .select()
      .from(creditFinalizationJobs)
      .where(
        eq(
          creditFinalizationJobs.reservationId,
          reservationId ?? "00000000-0000-0000-0000-000000000000",
        ),
      ),
  ).toHaveLength(0);
});

it("keeps withCreditReservation delivery and obligation in one transaction", async () => {
  const subjectId = await grantedSubject();
  const deliveryKey = `delivery:${crypto.randomUUID()}`;
  let reservationId: string | undefined;

  await expect(
    withCreditReservation(database.db, reserveInput(subjectId), {
      work: async () => ({ text: "generated" }),
      persistDelivery: async (_result, reservation, tx) => {
        reservationId = reservation.id;
        await tx.insert(platformMeta).values({ key: deliveryKey, value: "stored" });
        throw new Error("delivery transaction failed");
      },
    }),
  ).rejects.toThrow("delivery transaction failed");

  expect(
    await database.db.select().from(platformMeta).where(eq(platformMeta.key, deliveryKey)),
  ).toHaveLength(0);
  expect(
    await database.db
      .select()
      .from(creditFinalizationJobs)
      .where(
        eq(
          creditFinalizationJobs.reservationId,
          reservationId ?? "00000000-0000-0000-0000-000000000000",
        ),
      ),
  ).toHaveLength(0);
});

it("marks the executeCreditBackedWork obligation completed after direct commit", async () => {
  const subjectId = await grantedSubject();
  const deliveryReference = `delivery-${crypto.randomUUID()}`;
  const deliveryKey = `delivery:${deliveryReference}`;

  const result = await executeCreditBackedWork(database.db, reserveInput(subjectId), {
    work: async () => ({ text: "generated" }),
    persistDelivery: async (_generated, _reservation, tx) => {
      await tx.insert(platformMeta).values({ key: deliveryKey, value: "stored" });
      return { deliveryReference };
    },
  });

  expect(result.finalizationPending).toBe(false);
  expect(
    await database.db.query.creditFinalizationJobs.findFirst({
      where: eq(creditFinalizationJobs.deliveryReference, deliveryReference),
    }),
  ).toMatchObject({ state: "completed" });
});

it("marks the withCreditReservation obligation completed after direct commit", async () => {
  const subjectId = await grantedSubject();
  const deliveryReference = `delivery-${crypto.randomUUID()}`;
  const deliveryKey = `delivery:${deliveryReference}`;

  const result = await withCreditReservation(database.db, reserveInput(subjectId), {
    work: async () => ({ text: "generated" }),
    persistDelivery: async (_generated, _reservation, tx) => {
      await tx.insert(platformMeta).values({ key: deliveryKey, value: "stored" });
      return { deliveryReference };
    },
  });

  expect(result.finalizationPending).toBe(false);
  expect(
    await database.db.query.creditFinalizationJobs.findFirst({
      where: eq(creditFinalizationJobs.deliveryReference, deliveryReference),
    }),
  ).toMatchObject({ state: "completed" });
});

it("rolls back delivery when finalization obligation insertion fails", async () => {
  const deliveryReference = `delivery-${crypto.randomUUID()}`;
  const existingDeliveryKey = `delivery:${crypto.randomUUID()}`;
  const rejectedDeliveryKey = `delivery:${crypto.randomUUID()}`;
  const firstSubjectId = await grantedSubject();
  const secondSubjectId = await grantedSubject();

  await executeCreditBackedWork(database.db, reserveInput(firstSubjectId), {
    work: async () => ({ text: "first" }),
    persistDelivery: async (_generated, _reservation, tx) => {
      await tx.insert(platformMeta).values({ key: existingDeliveryKey, value: "stored" });
      return { deliveryReference };
    },
  });

  let enqueueError: unknown;
  try {
    await executeCreditBackedWork(database.db, reserveInput(secondSubjectId), {
      work: async () => ({ text: "second" }),
      persistDelivery: async (_generated, _reservation, tx) => {
        await tx.insert(platformMeta).values({ key: rejectedDeliveryKey, value: "stored" });
        return { deliveryReference };
      },
    });
  } catch (error) {
    enqueueError = error;
  }
  expect(enqueueError).toBeInstanceOf(Error);
  const enqueueCause = (enqueueError as Error).cause as { constraint_name?: string } | undefined;
  expect(enqueueCause?.constraint_name).toBe("credit_finalization_delivery_uq");

  expect(
    await database.db.select().from(platformMeta).where(eq(platformMeta.key, rejectedDeliveryKey)),
  ).toHaveLength(0);
  expect(
    await database.db
      .select()
      .from(creditFinalizationJobs)
      .where(eq(creditFinalizationJobs.deliveryReference, deliveryReference)),
  ).toHaveLength(1);
});

it("rejects a different delivery reference for an existing reservation obligation", async () => {
  const subjectId = await grantedSubject();
  const input = reserveInput(subjectId);
  const firstDeliveryReference = `delivery-${crypto.randomUUID()}`;
  const secondDeliveryReference = `delivery-${crypto.randomUUID()}`;
  const firstDeliveryKey = `delivery:${crypto.randomUUID()}`;
  const rejectedDeliveryKey = `delivery:${crypto.randomUUID()}`;
  let reservationId: string | undefined;

  const first = await executeCreditBackedWork(database.db, input, {
    work: async () => ({ text: "first" }),
    persistDelivery: async (_generated, reservation, tx) => {
      reservationId = reservation.id;
      await tx.insert(platformMeta).values({ key: firstDeliveryKey, value: "stored" });
      return { deliveryReference: firstDeliveryReference };
    },
    finalize: async () => {
      throw new Error("injected post-delivery commit outage");
    },
  });
  expect(first.finalizationPending).toBe(true);

  await expect(
    executeCreditBackedWork(database.db, input, {
      work: async () => ({ text: "retry" }),
      persistDelivery: async (_generated, _reservation, tx) => {
        await tx.insert(platformMeta).values({ key: rejectedDeliveryKey, value: "stored" });
        return { deliveryReference: secondDeliveryReference };
      },
    }),
  ).rejects.toThrow("credit finalization delivery reference conflict");

  expect(
    await database.db.select().from(platformMeta).where(eq(platformMeta.key, firstDeliveryKey)),
  ).toHaveLength(1);
  expect(
    await database.db.select().from(platformMeta).where(eq(platformMeta.key, rejectedDeliveryKey)),
  ).toHaveLength(0);
  expect(
    await database.db.query.creditFinalizationJobs.findFirst({
      where: eq(
        creditFinalizationJobs.reservationId,
        reservationId ?? "00000000-0000-0000-0000-000000000000",
      ),
    }),
  ).toMatchObject({
    state: "pending",
    deliveryReference: firstDeliveryReference,
  });

  expect(
    await runCreditFinalizationWorker(database.db, { owner: "conflict-test-cleanup" }),
  ).toMatchObject({ completed: 1 });
});

it("does not redo or release delivered work when credit commit temporarily fails", async () => {
  const subjectId = await grantedSubject();
  const deliveryReference = `delivery-${crypto.randomUUID()}`;
  const deliveryKey = `delivery:${deliveryReference}`;

  let workCalls = 0;
  let persistCalls = 0;
  let obligationObservedBeforeFinalize = false;
  const result = await executeCreditBackedWork(database.db, reserveInput(subjectId), {
    async work() {
      workCalls += 1;
      return { text: "durably delivered" };
    },
    async persistDelivery(_generated, _reservation, tx) {
      persistCalls += 1;
      await tx.insert(platformMeta).values({ key: deliveryKey, value: "stored" });
      return { deliveryReference };
    },
    async finalize({ reservationId }) {
      expect(
        await database.db.query.creditFinalizationJobs.findFirst({
          where: eq(creditFinalizationJobs.reservationId, reservationId),
        }),
      ).toMatchObject({ state: "pending", deliveryReference });
      expect(
        await database.db.select().from(platformMeta).where(eq(platformMeta.key, deliveryKey)),
      ).toHaveLength(1);
      obligationObservedBeforeFinalize = true;
      throw new Error("injected post-delivery commit outage");
    },
  });

  expect(result.finalizationPending).toBe(true);
  expect(result.deliveryReference).toBe(deliveryReference);
  expect(workCalls).toBe(1);
  expect(persistCalls).toBe(1);
  expect(obligationObservedBeforeFinalize).toBe(true);
  expect(
    await database.db.select().from(platformMeta).where(eq(platformMeta.key, deliveryKey)),
  ).toHaveLength(1);
  const jobs = await database.db.query.creditFinalizationJobs.findMany({
    where: eq(creditFinalizationJobs.deliveryReference, result.deliveryReference),
  });
  expect(jobs).toHaveLength(1);
  const [job] = jobs;
  expect(job).toMatchObject({ state: "pending" });
  const reservation = await database.db.query.creditReservations.findFirst({
    where: eq(creditReservations.id, job?.reservationId ?? "00000000-0000-0000-0000-000000000000"),
  });
  expect(reservation?.status).toBe("active");
  expect(await getCreditBalance(database.db, { subjectId, creditType: "reading" })).toMatchObject({
    available: 0,
    reserved: 1,
    consumed: 0,
  });

  const worker = await runCreditFinalizationWorker(database.db, { owner: "recovery-worker" });
  expect(worker.completed).toBe(1);
  expect(await getCreditBalance(database.db, { subjectId, creditType: "reading" })).toMatchObject({
    available: 0,
    reserved: 0,
    consumed: 1,
  });
  expect(
    await database.db.select().from(platformMeta).where(eq(platformMeta.key, deliveryKey)),
  ).toHaveLength(1);
  expect(
    await database.db
      .select()
      .from(creditFinalizationJobs)
      .where(eq(creditFinalizationJobs.deliveryReference, deliveryReference)),
  ).toHaveLength(1);
  expect(workCalls).toBe(1);
  expect(persistCalls).toBe(1);
});
