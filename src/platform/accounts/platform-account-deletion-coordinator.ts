import { featuresConfig } from "@/config/features.config";

import type { AccountDeletionCoordinator } from "./account-deletion-service";

export function createPlatformAccountDeletionCoordinator(): AccountDeletionCoordinator {
  return {
    async prepare({ operationKey }) {
      if (!operationKey) throw new Error("account deletion operation key is required");
      if (featuresConfig.commerce.enabled) {
        throw new Error("commerce deletion coordinator is not configured");
      }
    },
  };
}
