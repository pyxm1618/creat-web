import { describe, expect, it } from "vitest";

import { allocateCredits } from "@/platform/credits/domain/allocation";

describe("credit allocation", () => {
  it("uses earliest expiry, then oldest grant, then stable id", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    expect(
      allocateCredits(
        [
          { id: "z-no-expiry", available: 5, grantedAt: new Date("2026-01-01"), expiresAt: null },
          {
            id: "later-expiry",
            available: 5,
            grantedAt: new Date("2026-02-01"),
            expiresAt: new Date("2026-10-01"),
          },
          {
            id: "earlier-expiry",
            available: 3,
            grantedAt: new Date("2026-03-01"),
            expiresAt: new Date("2026-09-01"),
          },
        ],
        6,
        now,
      ),
    ).toEqual([
      { grantId: "earlier-expiry", quantity: 3 },
      { grantId: "later-expiry", quantity: 3 },
    ]);
  });

  it("rejects expired grants, invalid quantities and insufficient balance", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    expect(() =>
      allocateCredits(
        [{ id: "expired", available: 9, grantedAt: now, expiresAt: new Date("2026-07-01") }],
        1,
        now,
      ),
    ).toThrow("insufficient credits");
    expect(() => allocateCredits([], 0, now)).toThrow("positive safe integer");
    expect(() =>
      allocateCredits([{ id: "g", available: 1, grantedAt: now, expiresAt: null }], 2, now),
    ).toThrow("insufficient credits");
  });
});
