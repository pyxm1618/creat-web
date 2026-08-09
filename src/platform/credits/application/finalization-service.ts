import type { DatabaseClient } from "@/platform/database/client";
import { creditFinalizationJobs } from "@/platform/database/schema";

import { commitReservation, releaseReservation, reserveCredits } from "./reservation-service";
import type { CreditReservationRecord } from "./internal/credit-support";

export async function enqueueCreditFinalization(
  database: DatabaseClient,
  input: { readonly reservationId: string; readonly deliveryReference: string },
): Promise<void> {
  await database
    .insert(creditFinalizationJobs)
    .values({ reservationId: input.reservationId, deliveryReference: input.deliveryReference })
    .onConflictDoNothing({ target: creditFinalizationJobs.reservationId });
}

export async function withCreditReservation<T>(
  database: DatabaseClient,
  input: Parameters<typeof reserveCredits>[1],
  callbacks: {
    readonly work: (reservation: CreditReservationRecord) => Promise<T>;
    readonly persistDelivery: (
      result: T,
      reservation: CreditReservationRecord,
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

  const delivery = await callbacks.persistDelivery(result, reservation);
  try {
    await commitReservation(database, {
      reservationId: reservation.id,
      correlationId: `delivery:${delivery.deliveryReference}`,
    });
    return { result, finalizationPending: false };
  } catch {
    await enqueueCreditFinalization(database, {
      reservationId: reservation.id,
      deliveryReference: delivery.deliveryReference,
    });
    return { result, finalizationPending: true };
  }
}
