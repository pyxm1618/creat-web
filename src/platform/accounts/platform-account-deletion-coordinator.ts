import { and, eq, inArray } from "drizzle-orm";

import { lockAccountSubject } from "@/platform/accounts/account-subject-commerce-fence";
import { enqueueSubscriptionCommandInTransaction } from "@/platform/commerce/application/commerce-commands";
import type { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import type { DatabaseClient } from "@/platform/database/client";
import { commerceCommandJobs, subscriptions } from "@/platform/database/schema";

import type { AccountDeletionCoordinator } from "./account-deletion-service";

const PREPARED_SUBSCRIPTION_STATES = new Set(["canceling", "canceled", "expired", "closed"]);
const CANCELABLE_SUBSCRIPTION_STATES = new Set(["pending", "active", "past_due", "canceling"]);

export function createPlatformAccountDeletionCoordinator(input: {
  readonly database: DatabaseClient;
  readonly getCommerce: typeof getCommerceRuntime;
}): AccountDeletionCoordinator {
  return {
    async prepare({ subjectId, operationKey }) {
      const commerce = await input.getCommerce();
      if (!commerce) return;
      if (!operationKey) throw new Error("account deletion operation key is required");

      const outcome = await input.database.transaction(async (transaction) => {
        const subject = await lockAccountSubject(transaction, subjectId);
        if (subject.status !== "deletion_pending") {
          throw new Error("account deletion subject fence is not pending");
        }
        const subjectSubscriptions = await transaction
          .select({ id: subscriptions.id, status: subscriptions.status })
          .from(subscriptions)
          .where(eq(subscriptions.subjectId, subjectId))
          .for("update");
        let preparationPending = false;
        let operatorReviewRequired = false;

        for (const subscription of subjectSubscriptions) {
          const resumeCommands = await transaction
            .select({ state: commerceCommandJobs.state })
            .from(commerceCommandJobs)
            .where(
              and(
                eq(commerceCommandJobs.subjectId, subjectId),
                eq(commerceCommandJobs.targetId, subscription.id),
                eq(commerceCommandJobs.commandType, "subscription_resume"),
                inArray(commerceCommandJobs.state, ["pending", "processing", "dead_letter"]),
              ),
            )
            .for("update");
          if (resumeCommands.some((command) => command.state === "dead_letter")) {
            operatorReviewRequired = true;
            continue;
          }
          if (resumeCommands.length > 0) {
            preparationPending = true;
            continue;
          }

          const idempotencyKey = `account-delete:${operationKey}:${subscription.id}`;
          let [command] = await transaction
            .select()
            .from(commerceCommandJobs)
            .where(eq(commerceCommandJobs.idempotencyKey, idempotencyKey))
            .limit(1)
            .for("update");

          if (
            command &&
            (command.subjectId !== subjectId ||
              command.commandType !== "subscription_cancel" ||
              command.targetId !== subscription.id)
          ) {
            throw new Error("commerce command idempotency collision");
          }

          if (!command && CANCELABLE_SUBSCRIPTION_STATES.has(subscription.status)) {
            command = await enqueueSubscriptionCommandInTransaction(transaction, {
              subjectId,
              subscriptionId: subscription.id,
              command: "subscription_cancel",
              idempotencyKey,
            });
          }

          if (command?.state === "dead_letter") {
            operatorReviewRequired = true;
            continue;
          }

          if (
            !PREPARED_SUBSCRIPTION_STATES.has(subscription.status) ||
            (command !== undefined && command.state !== "completed")
          ) {
            preparationPending = true;
          }
        }

        if (operatorReviewRequired) {
          return "operator_review" as const;
        }
        if (preparationPending) {
          return "pending" as const;
        }
        return "prepared" as const;
      });
      if (outcome === "operator_review") {
        throw new Error("commerce account deletion requires operator review");
      }
      if (outcome === "pending") {
        throw new Error("commerce account deletion preparation pending");
      }
    },
  };
}
