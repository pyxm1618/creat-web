import { eq } from "drizzle-orm";

import { enqueueSubscriptionCommand } from "@/platform/commerce/application/commerce-commands";
import type { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import type { DatabaseClient } from "@/platform/database/client";
import { commerceCommandJobs, subscriptions } from "@/platform/database/schema";

import type { AccountDeletionCoordinator } from "./account-deletion-service";

const PREPARED_SUBSCRIPTION_STATES = new Set(["canceling", "canceled", "expired", "closed"]);
const CANCELABLE_SUBSCRIPTION_STATES = new Set(["active", "past_due", "canceling"]);

export function createPlatformAccountDeletionCoordinator(input: {
  readonly database: DatabaseClient;
  readonly getCommerce: typeof getCommerceRuntime;
}): AccountDeletionCoordinator {
  return {
    async prepare({ subjectId, operationKey }) {
      const commerce = await input.getCommerce();
      if (!commerce) return;
      if (!operationKey) throw new Error("account deletion operation key is required");

      const subjectSubscriptions = await input.database
        .select({ id: subscriptions.id, status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.subjectId, subjectId));
      let preparationPending = false;
      let operatorReviewRequired = false;

      for (const subscription of subjectSubscriptions) {
        const idempotencyKey = `account-delete:${operationKey}:${subscription.id}`;
        let [command] = await input.database
          .select()
          .from(commerceCommandJobs)
          .where(eq(commerceCommandJobs.idempotencyKey, idempotencyKey))
          .limit(1);

        if (
          command &&
          (command.subjectId !== subjectId ||
            command.commandType !== "subscription_cancel" ||
            command.targetId !== subscription.id)
        ) {
          throw new Error("commerce command idempotency collision");
        }

        if (!command && CANCELABLE_SUBSCRIPTION_STATES.has(subscription.status)) {
          await enqueueSubscriptionCommand(input.database, {
            subjectId,
            subscriptionId: subscription.id,
            command: "subscription_cancel",
            idempotencyKey,
          });
          [command] = await input.database
            .select()
            .from(commerceCommandJobs)
            .where(eq(commerceCommandJobs.idempotencyKey, idempotencyKey))
            .limit(1);
        }

        if (command?.state === "dead_letter") {
          operatorReviewRequired = true;
          continue;
        }

        const [currentSubscription] = await input.database
          .select({ status: subscriptions.status })
          .from(subscriptions)
          .where(eq(subscriptions.id, subscription.id))
          .limit(1);
        if (!currentSubscription) {
          preparationPending = true;
          continue;
        }

        if (
          !PREPARED_SUBSCRIPTION_STATES.has(currentSubscription.status) ||
          (command !== undefined && command.state !== "completed")
        ) {
          preparationPending = true;
        }
      }

      if (operatorReviewRequired) {
        throw new Error("commerce account deletion requires operator review");
      }
      if (preparationPending) {
        throw new Error("commerce account deletion preparation pending");
      }
    },
  };
}
