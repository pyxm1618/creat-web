import type { CreditAllocation, CreditGrantForAllocation } from "./types";

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("credit quantity must be a positive safe integer");
  }
}

export function allocateCredits(
  grants: readonly CreditGrantForAllocation[],
  quantity: number,
  now: Date,
): CreditAllocation[] {
  assertQuantity(quantity);
  const eligible = grants
    .filter(
      (grant) =>
        Number.isSafeInteger(grant.available) &&
        grant.available > 0 &&
        (!grant.expiresAt || grant.expiresAt > now),
    )
    .sort((left, right) => {
      if (left.expiresAt && right.expiresAt) {
        const expiry = left.expiresAt.getTime() - right.expiresAt.getTime();
        if (expiry !== 0) return expiry;
      } else if (left.expiresAt) {
        return -1;
      } else if (right.expiresAt) {
        return 1;
      }
      const granted = left.grantedAt.getTime() - right.grantedAt.getTime();
      if (granted !== 0) return granted;
      return left.id.localeCompare(right.id);
    });

  let remaining = quantity;
  const allocations: CreditAllocation[] = [];
  for (const grant of eligible) {
    if (remaining === 0) break;
    const allocated = Math.min(grant.available, remaining);
    allocations.push({ grantId: grant.id, quantity: allocated });
    remaining -= allocated;
  }
  if (remaining !== 0) throw new Error("insufficient credits");
  return allocations;
}
