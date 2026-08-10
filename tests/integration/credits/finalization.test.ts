import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { getCreditBalance, grantCredits } from "@/platform/credits/application/credit-service";
import { executeCreditBackedWork } from "@/platform/credits/application/execute-credit-backed-work";
import { withCreditReservation } from "@/platform/credits/application/finalization-service";
import { runCreditFinalizationWorker } from "@/platform/credits/application/finalization-worker";
import { createDatabaseClient, type DatabaseTransaction } from "@/platform/database/client";
import {
  accountSubjects,
  authSecurityEvents,
  creditFinalizationJobs,
  creditReservations,
  platformMeta,
} from "@/platform/database/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const testDatabaseUrl: string = databaseUrl;
const database = createDatabaseClient(testDatabaseUrl);

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

function twoPartyBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await ready;
  };
}

async function holdCreditMutationLock(subjectId: string): Promise<() => Promise<void>> {
  const lockDatabase = createDatabaseClient(testDatabaseUrl);
  let releaseLock: (() => void) | undefined;
  let acquiredLock: (() => void) | undefined;
  let rejectAcquisition: ((error: unknown) => void) | undefined;
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredLock = resolve;
    rejectAcquisition = reject;
  });
  const transaction = lockDatabase.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${subjectId}:reading`}, 0))`,
    );
    acquiredLock?.();
    await released;
  });
  void transaction.then(undefined, (error) => rejectAcquisition?.(error));

  try {
    await acquired;
  } catch (error) {
    await lockDatabase.close();
    throw error;
  }

  let releasedOnce = false;
  return async () => {
    if (releasedOnce) return;
    releasedOnce = true;
    releaseLock?.();
    try {
      await transaction;
    } finally {
      await lockDatabase.close();
    }
  };
}

async function waitForFinalizationLease(jobId: string, owner: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await database.db.query.creditFinalizationJobs.findFirst({
      where: eq(creditFinalizationJobs.id, jobId),
    });
    if (job?.state === "processing" && job.leaseOwner === owner) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`finalization lease was not acquired by ${owner}`);
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

it("treats sequential same-reference executeCreditBackedWork retries as completed", async () => {
  const subjectId = await grantedSubject();
  const input = reserveInput(subjectId);
  const deliveryReference = `delivery-${crypto.randomUUID()}`;
  const deliveryKey = `delivery:${crypto.randomUUID()}`;
  const callbacks = {
    work: async () => ({ text: "generated" }),
    persistDelivery: async (
      _generated: { text: string },
      _reservation: { id: string },
      tx: DatabaseTransaction,
    ) => {
      await tx
        .insert(platformMeta)
        .values({ key: deliveryKey, value: "stored" })
        .onConflictDoNothing({ target: platformMeta.key });
      return { deliveryReference };
    },
  };

  const first = await executeCreditBackedWork(database.db, input, callbacks);
  const retry = await executeCreditBackedWork(database.db, input, callbacks);

  expect(first.finalizationPending).toBe(false);
  expect(retry.finalizationPending).toBe(false);
  expect(
    await database.db.query.creditFinalizationJobs.findFirst({
      where: eq(creditFinalizationJobs.deliveryReference, deliveryReference),
    }),
  ).toMatchObject({ state: "completed" });
});

it("treats sequential same-reference withCreditReservation retries as completed", async () => {
  const subjectId = await grantedSubject();
  const input = reserveInput(subjectId);
  const deliveryReference = `delivery-${crypto.randomUUID()}`;
  const deliveryKey = `delivery:${crypto.randomUUID()}`;
  const callbacks = {
    work: async () => ({ text: "generated" }),
    persistDelivery: async (
      _generated: { text: string },
      _reservation: { id: string },
      tx: DatabaseTransaction,
    ) => {
      await tx
        .insert(platformMeta)
        .values({ key: deliveryKey, value: "stored" })
        .onConflictDoNothing({ target: platformMeta.key });
      return { deliveryReference };
    },
  };

  const first = await withCreditReservation(database.db, input, callbacks);
  const retry = await withCreditReservation(database.db, input, callbacks);

  expect(first.finalizationPending).toBe(false);
  expect(retry.finalizationPending).toBe(false);
  expect(
    await database.db.query.creditFinalizationJobs.findFirst({
      where: eq(creditFinalizationJobs.deliveryReference, deliveryReference),
    }),
  ).toMatchObject({ state: "completed" });
});

it("treats concurrent same-reference executeCreditBackedWork retries as completed", async () => {
  const subjectId = await grantedSubject();
  const input = reserveInput(subjectId);
  const deliveryReference = `delivery-${crypto.randomUUID()}`;
  const deliveryKey = `delivery:${crypto.randomUUID()}`;
  const rendezvous = twoPartyBarrier();
  const call = () =>
    executeCreditBackedWork(database.db, input, {
      work: async () => ({ text: "generated" }),
      persistDelivery: async (_generated, _reservation, tx) => {
        await rendezvous();
        await tx
          .insert(platformMeta)
          .values({ key: deliveryKey, value: "stored" })
          .onConflictDoNothing({ target: platformMeta.key });
        return { deliveryReference };
      },
    });

  const results = await Promise.all([call(), call()]);

  expect(results.map((result) => result.finalizationPending)).toEqual([false, false]);
  expect(
    await database.db.query.creditFinalizationJobs.findFirst({
      where: eq(creditFinalizationJobs.deliveryReference, deliveryReference),
    }),
  ).toMatchObject({ state: "completed" });
});

it("treats concurrent same-reference withCreditReservation retries as completed", async () => {
  const subjectId = await grantedSubject();
  const input = reserveInput(subjectId);
  const deliveryReference = `delivery-${crypto.randomUUID()}`;
  const deliveryKey = `delivery:${crypto.randomUUID()}`;
  const rendezvous = twoPartyBarrier();
  const call = () =>
    withCreditReservation(database.db, input, {
      work: async () => ({ text: "generated" }),
      persistDelivery: async (_generated, _reservation, tx) => {
        await rendezvous();
        await tx
          .insert(platformMeta)
          .values({ key: deliveryKey, value: "stored" })
          .onConflictDoNothing({ target: platformMeta.key });
        return { deliveryReference };
      },
    });

  const results = await Promise.all([call(), call()]);

  expect(results.map((result) => result.finalizationPending)).toEqual([false, false]);
  expect(
    await database.db.query.creditFinalizationJobs.findFirst({
      where: eq(creditFinalizationJobs.deliveryReference, deliveryReference),
    }),
  ).toMatchObject({ state: "completed" });
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

it("does not complete or count a finalization job after its lease is reclaimed", async () => {
  const subjectId = await grantedSubject();
  const deliveryReference = `delivery-${crypto.randomUUID()}`;
  const deliveryKey = `delivery:${deliveryReference}`;
  const result = await executeCreditBackedWork(database.db, reserveInput(subjectId), {
    work: async () => ({ text: "durably delivered" }),
    persistDelivery: async (_generated, _reservation, tx) => {
      await tx.insert(platformMeta).values({ key: deliveryKey, value: "stored" });
      return { deliveryReference };
    },
    finalize: async () => {
      throw new Error("injected direct finalization outage");
    },
  });
  const job = await database.db.query.creditFinalizationJobs.findFirst({
    where: eq(creditFinalizationJobs.deliveryReference, result.deliveryReference),
  });
  if (!job) throw new Error("finalization job fixture failed");

  const oldNow = new Date(Date.now() + 1_000);
  const releaseCreditLock = await holdCreditMutationLock(subjectId);
  const oldWorker = runCreditFinalizationWorker(database.db, {
    owner: "old-completion-owner",
    now: oldNow,
    limit: 1,
  });
  try {
    await waitForFinalizationLease(job.id, "old-completion-owner");
    const [reclaimed] = await database.db
      .update(creditFinalizationJobs)
      .set({
        state: "processing",
        leaseOwner: "new-completion-owner",
        leaseExpiresAt: new Date(oldNow.getTime() + 10 * 60 * 1000),
      })
      .where(
        and(
          eq(creditFinalizationJobs.id, job.id),
          eq(creditFinalizationJobs.state, "processing"),
          eq(creditFinalizationJobs.leaseOwner, "old-completion-owner"),
        ),
      )
      .returning({ id: creditFinalizationJobs.id });
    expect(reclaimed?.id).toBe(job.id);
  } finally {
    await releaseCreditLock();
  }

  await expect(oldWorker).resolves.toEqual({ completed: 0, deferred: 0 });
  expect(
    await database.db.query.creditFinalizationJobs.findFirst({
      where: eq(creditFinalizationJobs.id, job.id),
    }),
  ).toMatchObject({
    state: "processing",
    leaseOwner: "new-completion-owner",
  });
});

it("does not defer or dead-letter a finalization job after its lease is reclaimed", async () => {
  const subjectId = await grantedSubject();
  const committedDeliveryReference = `delivery-${crypto.randomUUID()}`;
  const deliveryKey = `delivery:${committedDeliveryReference}`;
  const result = await executeCreditBackedWork(database.db, reserveInput(subjectId), {
    work: async () => ({ text: "durably delivered" }),
    persistDelivery: async (_generated, _reservation, tx) => {
      await tx.insert(platformMeta).values({ key: deliveryKey, value: "stored" });
      return { deliveryReference: committedDeliveryReference };
    },
  });
  const job = await database.db.query.creditFinalizationJobs.findFirst({
    where: eq(creditFinalizationJobs.deliveryReference, result.deliveryReference),
  });
  if (!job) throw new Error("finalization job fixture failed");

  const conflictingDeliveryReference = `delivery-${crypto.randomUUID()}`;
  const oldNow = new Date(Date.now() + 1_000);
  await database.db
    .update(creditFinalizationJobs)
    .set({
      state: "pending",
      attempts: 11,
      deliveryReference: conflictingDeliveryReference,
      nextAttemptAt: oldNow,
      completedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(creditFinalizationJobs.id, job.id));

  const releaseCreditLock = await holdCreditMutationLock(subjectId);
  const oldWorker = runCreditFinalizationWorker(database.db, {
    owner: "old-failure-owner",
    now: oldNow,
    limit: 1,
  });
  try {
    await waitForFinalizationLease(job.id, "old-failure-owner");
    const [reclaimed] = await database.db
      .update(creditFinalizationJobs)
      .set({
        state: "processing",
        leaseOwner: "new-failure-owner",
        leaseExpiresAt: new Date(oldNow.getTime() + 10 * 60 * 1000),
      })
      .where(
        and(
          eq(creditFinalizationJobs.id, job.id),
          eq(creditFinalizationJobs.state, "processing"),
          eq(creditFinalizationJobs.leaseOwner, "old-failure-owner"),
        ),
      )
      .returning({ id: creditFinalizationJobs.id });
    expect(reclaimed?.id).toBe(job.id);
  } finally {
    await releaseCreditLock();
  }

  await expect(oldWorker).resolves.toEqual({ completed: 0, deferred: 0 });
  expect(
    await database.db.query.creditFinalizationJobs.findFirst({
      where: eq(creditFinalizationJobs.id, job.id),
    }),
  ).toMatchObject({
    state: "processing",
    attempts: 11,
    leaseOwner: "new-failure-owner",
  });
  expect(
    await database.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.eventType, "dead_letter_created"),
          sql`${authSecurityEvents.details}->>'queue' = 'credit_finalization'`,
        ),
      ),
  ).toHaveLength(0);
});
