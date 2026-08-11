import { describe, expect, it } from "vitest";

import { deleteIdentityBeforeDetach } from "@/platform/accounts/account-deletion-identity";

describe("account deletion identity ordering", () => {
  it("keeps the subject binding when Better Auth deletion fails", async () => {
    const operations: string[] = [];

    await expect(
      deleteIdentityBeforeDetach({
        authUserId: "user-1",
        deleteUser: async () => {
          operations.push("delete-identity");
          throw new Error("Better Auth unavailable");
        },
        confirmDetached: async () => {
          operations.push("confirm-detached");
        },
      }),
    ).rejects.toThrow("Better Auth unavailable");
    expect(operations).toEqual(["delete-identity"]);
  });

  it("confirms the FK detach only after identity deletion succeeds", async () => {
    const operations: string[] = [];

    await deleteIdentityBeforeDetach({
      authUserId: "user-1",
      deleteUser: async () => {
        operations.push("delete-identity");
      },
      confirmDetached: async () => {
        operations.push("confirm-detached");
      },
    });

    expect(operations).toEqual(["delete-identity", "confirm-detached"]);
  });

  it("resumes an old post-delete state when the FK already nulled the request identity", async () => {
    const operations: string[] = [];

    await deleteIdentityBeforeDetach({
      authUserId: null,
      deleteUser: async () => {
        operations.push("delete-identity");
      },
      confirmDetached: async () => {
        operations.push("confirm-detached");
      },
    });

    expect(operations).toEqual(["confirm-detached"]);
  });
});
