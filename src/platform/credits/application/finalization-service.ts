import { and, eq } from "drizzle-orm";

import type { DatabaseClient, DatabaseTransaction } from "@/platform/database/client";
import { creditFinalizationJobs } from "@/platform/database/schema";

import { commitReservation, releaseReservation, reserveCredits } from "./reservation-service";
import type { CreditReservationRecord } from "./internal/credit-support";

export async function enqueueCreditFinalization(
  database: DatabaseClient | DatabaseTransaction,
  input: { readonly reservationId: string; readonly deliveryReference: string },
): Promise<void> {
  await database
    .insert(creditFinalizationJobs)
    .values({ reservationId: input.reservationId, deliveryReference: input.deliveryReference })
    .onConflictDoNothing({ target: creditFinalizationJobs.reservationId });
}

export async function completeCreditFinalization(
  database: DatabaseClient,
  input: { readonly reservationId: string; readonly now?: Date },
): Promise<void> {
  const [completed] = await database
    .update(creditFinalizationJobs)
    .set({ state: "completed", completedAt: input.now ?? new Date() })
    .where(
      and(
        eq(creditFinalizationJobs.reservationId, input.reservationId),
        eq(creditFinalizationJobs.state, "pending"),
      ),
    )
    .returning({ id: creditFinalizationJobs.id });
  if (!completed) throw new Error("credit finalization obligation completion failed");
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

  const delivery = await database.transaction(async (tx) => {
    const stored = await callbacks.persistDelivery(result, reservation, tx);
    await enqueueCreditFinalization(tx, {
      reservationId: reservation.id,
      deliveryReference: stored.deliveryReference,
    });
    return stored;
  });
  try {
    await commitReservation(database, {
      reservationId: reservation.id,
      correlationId: `delivery:${delivery.deliveryReference}`,
    });
    await completeCreditFinalization(database, { reservationId: reservation.id });
    return { result, finalizationPending: false };
  } catch {
    return { result, finalizationPending: true };
  }
}
