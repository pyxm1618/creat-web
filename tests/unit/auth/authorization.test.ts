import { describe, expect, it } from "vitest";

import { assertOwner, assertOperator } from "@/platform/auth/authorization";
import { assertFreshSession } from "@/platform/auth/session";

describe("authorization policies", () => {
  it("allows only the resource owner", () => {
    expect(() =>
      assertOwner({ authenticatedUserId: "user_1", ownerUserId: "user_1" }),
    ).not.toThrow();
    expect(() => assertOwner({ authenticatedUserId: "user_1", ownerUserId: "user_2" })).toThrow(
      "resource access denied",
    );
  });

  it("requires the explicit operator role", () => {
    expect(() => assertOperator({ role: "operator" })).not.toThrow();
    expect(() => assertOperator({ role: "user" })).toThrow("operator access required");
  });
});

describe("fresh session policy", () => {
  it("accepts a session authenticated within fifteen minutes", () => {
    expect(() =>
      assertFreshSession(
        { authenticatedAt: new Date("2026-08-06T10:00:00Z") },
        new Date("2026-08-06T10:14:59Z"),
      ),
    ).not.toThrow();
  });

  it("rejects stale and future-dated authentication", () => {
    expect(() =>
      assertFreshSession(
        { authenticatedAt: new Date("2026-08-06T10:00:00Z") },
        new Date("2026-08-06T10:15:01Z"),
      ),
    ).toThrow("fresh authentication required");

    expect(() =>
      assertFreshSession(
        { authenticatedAt: new Date("2026-08-06T10:01:00Z") },
        new Date("2026-08-06T10:00:00Z"),
      ),
    ).toThrow("invalid session timestamp");
  });
});
