import { describe, expect, it } from "vitest";

import { probeCommerceAccountDeletionCoordinator } from "../../../scripts/account-deletion-release-probe";

describe("account deletion release probe", () => {
  it("constructs and executes the real coordinator with non-null Commerce", async () => {
    await expect(probeCommerceAccountDeletionCoordinator()).resolves.toBeUndefined();
  });

  it("rejects a coordinator stub that ignores the runtime and durable fence", async () => {
    await expect(
      probeCommerceAccountDeletionCoordinator({
        createCoordinator: () => ({ prepare: async () => undefined }),
      }),
    ).rejects.toThrow("account deletion coordinator probe did not exercise durable Commerce");
  });
});
