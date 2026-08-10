import type { DatabaseClient, DatabaseTransaction } from "@/platform/database/client";

import {
  commitReservation,
  releaseReservation,
  reserveCredits,
  type CreditReservationRecord,
} from "./credit-service";
import { completeCreditFinalization, enqueueCreditFinalization } from "./finalization-service";

export async function executeCreditBackedWork<T>(
  database: DatabaseClient,
  input: Parameters<typeof reserveCredits>[1],
  callbacks: {
    readonly work: (reservation: CreditReservationRecord) => Promise<T>;
    readonly persistDelivery: (
      result: T,
      reservation: CreditReservationRecord,
      tx: DatabaseTransaction,
    ) => Promise<{ readonly deliveryReference: string }>;
    readonly finalize?: (input: {
      readonly reservationId: string;
      readonly correlationId: string;
    }) => Promise<void>;
  },
): Promise<{
  readonly result: T;
  readonly deliveryReference: string;
  readonly finalizationPending: boolean;
}> {
  const reservation = await reserveCredits(database, input);

  let result: T;
  try {
    result = await callbacks.work(reservation);
  } catch (error) {
    await releaseReservation(database, {
      reservationId: reservation.id,
      correlationId: `work-failed:${reservation.id}`,
      reason: "product_work_failed_before_delivery",
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
  const correlationId = `delivery:${delivery.deliveryReference}`;
  try {
    if (callbacks.finalize) {
      await callbacks.finalize({ reservationId: reservation.id, correlationId });
    } else {
      await commitReservation(database, { reservationId: reservation.id, correlationId });
    }
    await completeCreditFinalization(database, { reservationId: reservation.id });
    return {
      result,
      deliveryReference: delivery.deliveryReference,
      finalizationPending: false,
    };
  } catch {
    return {
      result,
      deliveryReference: delivery.deliveryReference,
      finalizationPending: true,
    };
  }
}
