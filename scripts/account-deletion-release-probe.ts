import type { AccountDeletionCoordinator } from "@/platform/accounts/account-deletion-service";
import { createPlatformAccountDeletionCoordinator } from "@/platform/accounts/platform-account-deletion-coordinator";
import { accountSubjects, subscriptions } from "@/platform/database/schema";

type CoordinatorFactory = (
  input: Parameters<typeof createPlatformAccountDeletionCoordinator>[0],
) => AccountDeletionCoordinator;

export async function probeCommerceAccountDeletionCoordinator(input?: {
  readonly createCoordinator?: CoordinatorFactory;
}): Promise<void> {
  let commerceResolved = false;
  let durableTransactionEntered = false;
  let subjectLocked = false;
  let subscriptionsLocked = false;
  const transaction = {
    select() {
      return {
        from(table: unknown) {
          const rows =
            table === accountSubjects
              ? [{ id: "00000000-0000-4000-8000-000000000001", status: "deletion_pending" }]
              : [];
          return {
            where() {
              return {
                limit() {
                  return {
                    for(mode: string) {
                      if (table === accountSubjects && mode === "update") subjectLocked = true;
                      return Promise.resolve(rows);
                    },
                  };
                },
                for(mode: string) {
                  if (table === subscriptions && mode === "update") subscriptionsLocked = true;
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  };
  const database = {
    transaction: async <T>(callback: (value: typeof transaction) => Promise<T>) => {
      durableTransactionEntered = true;
      return callback(transaction);
    },
  };
  const createCoordinator = input?.createCoordinator ?? createPlatformAccountDeletionCoordinator;
  const coordinator = createCoordinator({
    database: database as never,
    getCommerce: async () => {
      commerceResolved = true;
      return { database } as never;
    },
  });

  await coordinator.prepare({
    subjectId: "00000000-0000-4000-8000-000000000001",
    operationKey: "release-probe-operation",
  });
  if (!commerceResolved || !durableTransactionEntered || !subjectLocked || !subscriptionsLocked) {
    throw new Error("account deletion coordinator probe did not exercise durable Commerce");
  }
}
