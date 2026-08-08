import type { DatabaseClient } from "@/platform/database/client";

import {
  commitReservation,
  enqueueCreditFinalization,
  releaseReservation,
  reserveCredits,
  type CreditReservationRecord,
} from "./credit-service";

export async function executeCreditBackedWork<T>(
  database: DatabaseClient,
  input: Parameters<typeof reserveCredits>[1],
  callbacks: {
    readonly work: (reservation: CreditReservationRecord) => Promise<T>;
    readonly persistDelivery: (
      result: T,
      reservation: CreditReservationRecord,
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

  const delivery = await callbacks.persistDelivery(result, reservation);
  const correlationId = `delivery:${delivery.deliveryReference}`;
  try {
    if (callbacks.finalize) {
      await callbacks.finalize({ reservationId: reservation.id, correlationId });
    } else {
      await commitReservation(database, { reservationId: reservation.id, correlationId });
    }
    return {
      result,
      deliveryReference: delivery.deliveryReference,
      finalizationPending: false,
    };
  } catch {
    await enqueueCreditFinalization(database, {
      reservationId: reservation.id,
      deliveryReference: delivery.deliveryReference,
    });
    return {
      result,
      deliveryReference: delivery.deliveryReference,
      finalizationPending: true,
    };
  }
}
