import type { CreditReservationStatus } from "./types";

export function assertCreditQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("credit quantity must be a positive safe integer");
  }
}

export function assertReservationTerminalTransition(
  current: CreditReservationStatus,
  target: "committed" | "released" | "expired",
): void {
  if (current === target) return;
  if (current !== "active") {
    throw new Error(`invalid credit reservation transition: ${current} -> ${target}`);
  }
}

export function assertReservationExpiry(expiresAt: Date, now: Date): void {
  if (!(expiresAt > now)) throw new Error("credit reservation expiry must be in the future");
}
