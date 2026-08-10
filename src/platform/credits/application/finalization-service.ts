import { and, eq } from "drizzle-orm";

import type { DatabaseClient, DatabaseTransaction } from "@/platform/database/client";
import { creditFinalizationJobs } from "@/platform/database/schema";

import { commitReservation, releaseReservation, reserveCredits } from "./reservation-service";
import type { CreditReservationRecord } from "./internal/credit-support";

export type CreditFinalizationObligation = Readonly<{
  id: string;
  reservationId: string;
  deliveryReference: string;
}>;

export async function enqueueCreditFinalization(
  database: DatabaseClient | DatabaseTransaction,
  input: { readonly reservationId: string; readonly deliveryReference: string },
): Promise<CreditFinalizationObligation> {
  const [inserted] = await database
    .insert(creditFinalizationJobs)
    .values({ reservationId: input.reservationId, deliveryReference: input.deliveryReference })
    .onConflictDoNothing({ target: creditFinalizationJobs.reservationId })
    .returning({
      id: creditFinalizationJobs.id,
      reservationId: creditFinalizationJobs.reservationId,
      deliveryReference: creditFinalizationJobs.deliveryReference,
    });
  if (inserted) return inserted;

  const [existing] = await database
    .select({
      id: creditFinalizationJobs.id,
      reservationId: creditFinalizationJobs.reservationId,
      deliveryReference: creditFinalizationJobs.deliveryReference,
    })
    .from(creditFinalizationJobs)
    .where(eq(creditFinalizationJobs.reservationId, input.reservationId))
    .limit(1);
  if (!existing) throw new Error("credit finalization obligation conflict lookup failed");
  if (existing.deliveryReference !== input.deliveryReference) {
    throw new Error("credit finalization delivery reference conflict");
  }
  return existing;
}

export async function completeCreditFinalization(
  database: DatabaseClient,
  input: CreditFinalizationObligation & { readonly now?: Date },
): Promise<void> {
  const [completed] = await database
    .update(creditFinalizationJobs)
    .set({ state: "completed", completedAt: input.now ?? new Date() })
    .where(
      and(
        eq(creditFinalizationJobs.id, input.id),
        eq(creditFinalizationJobs.reservationId, input.reservationId),
        eq(creditFinalizationJobs.deliveryReference, input.deliveryReference),
        eq(creditFinalizationJobs.state, "pending"),
      ),
    )
    .returning({ id: creditFinalizationJobs.id });
  if (completed) return;

  const [existing] = await database
    .select({ state: creditFinalizationJobs.state })
    .from(creditFinalizationJobs)
    .where(
      and(
        eq(creditFinalizationJobs.id, input.id),
        eq(creditFinalizationJobs.reservationId, input.reservationId),
        eq(creditFinalizationJobs.deliveryReference, input.deliveryReference),
      ),
    )
    .limit(1);
  if (existing?.state === "completed") return;
  throw new Error("credit finalization obligation completion failed");
}

export async function withCreditReservation<T>(
  database: DatabaseClient,
  input: Parameters<typeof reserveCredits>[1],
  callbacks: {
    readonly work: (reservation: CreditReservationRecord) => Promise<T>;
    readonly persistDelivery: (
      result: T,
      reservation: CreditReservationRecord,
      tx: DatabaseTransaction,
    ) => Promise<{ readonly deliveryReference: string }>;
  },
): Promise<{ readonly result: T; readonly finalizationPending: boolean }> {
  const reservation = await reserveCredits(database, input);
  let result: T;
  try {
    result = await callbacks.work(reservation);
  } catch (error) {
    await releaseReservation(database, {
      reservationId: reservation.id,
      correlationId: `work-failed:${reservation.id}`,
      reason: "product_work_failed",
    });
    throw error;
  }

  const persisted = await database.transaction(async (tx) => {
    const stored = await callbacks.persistDelivery(result, reservation, tx);
    const obligation = await enqueueCreditFinalization(tx, {
      reservationId: reservation.id,
      deliveryReference: stored.deliveryReference,
    });
    return { delivery: stored, obligation };
  });
  try {
    await commitReservation(database, {
      reservationId: reservation.id,
      correlationId: `delivery:${persisted.delivery.deliveryReference}`,
    });
    await completeCreditFinalization(database, persisted.obligation);
    return { result, finalizationPending: false };
  } catch {
    return { result, finalizationPending: true };
  }
}
