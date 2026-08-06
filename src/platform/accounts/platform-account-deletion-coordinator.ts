import { featuresConfig } from "@/config/features.config";

import type { AccountDeletionCoordinator } from "./account-deletion-service";

export function createPlatformAccountDeletionCoordinator(): AccountDeletionCoordinator {
  return {
    async prepare() {
      if (featuresConfig.commerce.enabled) {
        throw new Error("commerce deletion coordinator is not configured");
      }
    },
  };
}
