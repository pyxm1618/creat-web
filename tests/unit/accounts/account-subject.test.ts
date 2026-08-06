import { describe, expect, it } from "vitest";

import { transitionAccountSubject } from "@/platform/accounts/account-subject";

describe("retained account subject lifecycle", () => {
  it("starts and completes deletion idempotently", () => {
    expect(transitionAccountSubject("active", "begin_deletion")).toBe("deletion_pending");
    expect(transitionAccountSubject("deletion_pending", "begin_deletion")).toBe(
      "deletion_pending",
    );
    expect(transitionAccountSubject("deletion_pending", "complete_deletion")).toBe("deleted");
    expect(transitionAccountSubject("deleted", "complete_deletion")).toBe("deleted");
  });

  it("never reactivates or skips the pending state", () => {
    expect(() => transitionAccountSubject("deleted", "begin_deletion")).toThrow(
      "deleted subject cannot restart deletion",
    );
    expect(() => transitionAccountSubject("active", "complete_deletion")).toThrow(
      "subject deletion must begin before completion",
    );
  });
});
