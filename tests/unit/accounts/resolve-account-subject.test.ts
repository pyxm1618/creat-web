import { describe, expect, it, vi } from "vitest";

import { ensureActiveAccountSubject } from "@/platform/accounts/resolve-account-subject";
import type { AccountSubjectRepository } from "@/platform/accounts/account-subject-repository";

const activeSubject = {
  id: "subject_1",
  authUserId: "user_1",
  status: "active" as const,
  pseudonymousKey: "pseudo_1",
  createdAt: new Date("2026-08-06T00:00:00Z"),
  deletionRequestedAt: null,
  deletedAt: null,
};

describe("ensureActiveAccountSubject", () => {
  it("returns an existing active subject without creating another", async () => {
    const repository = {
      getActiveByAuthUserId: vi.fn().mockResolvedValue(activeSubject),
      ensureForAuthUser: vi.fn(),
    } as unknown as AccountSubjectRepository;

    await expect(ensureActiveAccountSubject(repository, "user_1")).resolves.toEqual(activeSubject);
    expect(repository.ensureForAuthUser).not.toHaveBeenCalled();
  });

  it("repairs a missing subject idempotently", async () => {
    const repository = {
      getActiveByAuthUserId: vi.fn().mockResolvedValue(null),
      ensureForAuthUser: vi.fn().mockResolvedValue(activeSubject),
    } as unknown as AccountSubjectRepository;

    await expect(ensureActiveAccountSubject(repository, "user_1")).resolves.toEqual(activeSubject);
    expect(repository.ensureForAuthUser).toHaveBeenCalledWith("user_1");
  });

  it("fails closed when the repaired subject is not active", async () => {
    const repository = {
      getActiveByAuthUserId: vi.fn().mockResolvedValue(null),
      ensureForAuthUser: vi.fn().mockResolvedValue({ ...activeSubject, status: "deletion_pending" }),
    } as unknown as AccountSubjectRepository;

    await expect(ensureActiveAccountSubject(repository, "user_1")).rejects.toThrow(
      "active account subject required",
    );
  });
});
