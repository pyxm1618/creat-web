import { describe, expect, it } from "vitest";

import { accountSubjects, subscriptions } from "@/platform/database/schema";
import { createPlatformAccountDeletionCoordinator } from "@/platform/accounts/platform-account-deletion-coordinator";
import {
  lockAccountSubject,
  requireActiveAccountSubject,
} from "@/platform/accounts/account-subject-commerce-fence";
import {
  assertSubscriptionCommandAllowed,
  enqueueSubscriptionCommand,
} from "@/platform/commerce/application/commerce-commands";
import { runFencedCheckout } from "@/platform/commerce/application/fenced-checkout";
import { executeSubscriptionResume } from "@/platform/commerce/application/execute-subscription-resume";
import {
  guardSubscriptionEventForSubject,
  subscriptionEventDisposition,
} from "@/platform/commerce/application/subscription-account-deletion-policy";

describe("account deletion Commerce fence", () => {
  function commandDatabase(input: {
    readonly subjectStatus: "active" | "deletion_pending";
    readonly subscriptionStatus: "pending" | "canceling";
  }) {
    const transaction = {
      select() {
        return {
          from(table: unknown) {
            const rows =
              table === accountSubjects
                ? [{ id: "subject-1", status: input.subjectStatus }]
                : table === subscriptions
                  ? [
                      {
                        id: "subscription-1",
                        subjectId: "subject-1",
                        status: input.subscriptionStatus,
                      },
                    ]
                  : [];
            return {
              where() {
                return {
                  limit() {
                    return {
                      for() {
                        return Promise.resolve(rows);
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      query: {
        commerceCommandJobs: {
          findFirst: async () => undefined,
        },
      },
      insert() {
        return {
          values() {
            return {
              onConflictDoNothing() {
                return {
                  returning: async () => [
                    {
                      id: "command-1",
                      subjectId: "subject-1",
                      targetId: "subscription-1",
                      commandType: "subscription_cancel",
                      state: "pending",
                    },
                  ],
                };
              },
            };
          },
        };
      },
    };
    return {
      transaction: async <T>(callback: (value: typeof transaction) => Promise<T>) =>
        callback(transaction),
    };
  }

  it("locks the durable account-subject fence before a Commerce mutation", async () => {
    const operations: string[] = [];
    const row = { id: "subject-1", status: "deletion_pending" };
    const transaction = {
      select() {
        operations.push("select");
        return {
          from() {
            operations.push("from");
            return {
              where() {
                operations.push("where");
                return {
                  limit() {
                    operations.push("limit");
                    return {
                      for(mode: string) {
                        operations.push(`for:${mode}`);
                        return Promise.resolve([row]);
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    await expect(lockAccountSubject(transaction as never, "subject-1")).resolves.toBe(row);
    expect(operations).toEqual(["select", "from", "where", "limit", "for:update"]);
  });

  it("runs the coordinator final scan inside the locked subject transaction", async () => {
    const operations: string[] = [];
    const transaction = {
      select() {
        return {
          from(table: unknown) {
            const rows =
              table === accountSubjects
                ? [{ id: "subject-1", status: "deletion_pending" }]
                : table === subscriptions
                  ? []
                  : [];
            return {
              where() {
                return {
                  limit() {
                    return {
                      for(mode: string) {
                        operations.push(
                          table === accountSubjects ? `subject:${mode}` : `subscription:${mode}`,
                        );
                        return Promise.resolve(rows);
                      },
                    };
                  },
                  for(mode: string) {
                    operations.push(`subscription:${mode}`);
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
      select() {
        throw new Error("unfenced database access");
      },
      transaction: async <T>(callback: (value: typeof transaction) => Promise<T>) => {
        operations.push("transaction");
        return callback(transaction);
      },
    };
    const coordinator = createPlatformAccountDeletionCoordinator({
      database: database as never,
      getCommerce: async () => ({ database }) as never,
    });

    await expect(
      coordinator.prepare({ subjectId: "subject-1", operationKey: "operation-1" }),
    ).resolves.toBeUndefined();
    expect(operations).toEqual(["transaction", "subject:update", "subscription:update"]);
  });

  it("requires an active subject for customer-initiated Commerce mutations", () => {
    expect(() => requireActiveAccountSubject({ status: "active" })).not.toThrow();
    expect(() => requireActiveAccountSubject({ status: "deletion_pending" })).toThrow(
      "account subject is not active",
    );
    expect(() => requireActiveAccountSubject({ status: "deleted" })).toThrow(
      "account subject is not active",
    );
  });

  it("checks the subject before provider checkout and again before returning its URL", async () => {
    const operations: string[] = [];

    await expect(
      runFencedCheckout({
        claimWhileSubjectActive: async () => {
          operations.push("claim-active");
          return { orderId: "order-1" };
        },
        callProvider: async () => {
          operations.push("provider");
          return { checkoutUrl: "https://checkout.example/session-1" };
        },
        commitWhileSubjectActive: async () => {
          operations.push("commit-active");
          throw new Error("account subject is not active");
        },
        failClaim: async () => {
          operations.push("fail-claim");
        },
      }),
    ).rejects.toThrow("account subject is not active");
    expect(operations).toEqual(["claim-active", "provider", "commit-active", "fail-claim"]);
  });

  it("allows deletion cancellation of a pending subscription but blocks resume", () => {
    expect(() =>
      assertSubscriptionCommandAllowed({
        subjectStatus: "deletion_pending",
        subscriptionStatus: "pending",
        command: "subscription_cancel",
      }),
    ).not.toThrow();
    expect(() =>
      assertSubscriptionCommandAllowed({
        subjectStatus: "deletion_pending",
        subscriptionStatus: "canceling",
        command: "subscription_resume",
      }),
    ).toThrow("account deletion prevents subscription resume");
  });

  it("enforces the subject fence in the real subscription command boundary", async () => {
    await expect(
      enqueueSubscriptionCommand(
        commandDatabase({
          subjectStatus: "deletion_pending",
          subscriptionStatus: "canceling",
        }) as never,
        {
          subjectId: "subject-1",
          subscriptionId: "subscription-1",
          command: "subscription_resume",
          idempotencyKey: "resume:deletion:subject-1",
        },
      ),
    ).rejects.toThrow("account deletion prevents subscription resume");

    await expect(
      enqueueSubscriptionCommand(
        commandDatabase({
          subjectStatus: "deletion_pending",
          subscriptionStatus: "pending",
        }) as never,
        {
          subjectId: "subject-1",
          subscriptionId: "subscription-1",
          command: "subscription_cancel",
          idempotencyKey: "cancel:deletion:subject-1",
        },
      ),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("safely completes a queued resume without calling the provider after deletion starts", async () => {
    let providerCalls = 0;
    const transaction = {
      select() {
        return {
          from(table: unknown) {
            const rows =
              table === accountSubjects
                ? [{ id: "subject-1", status: "deletion_pending" }]
                : [
                    {
                      id: "subscription-1",
                      subjectId: "subject-1",
                      status: "canceling",
                      environment: "test",
                      externalOrderId: "provider-order-1",
                    },
                  ];
            return {
              where() {
                return {
                  limit() {
                    return {
                      for() {
                        return Promise.resolve(rows);
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
    const database = {
      query: {
        subscriptions: {
          findFirst: async () => ({
            id: "subscription-1",
            subjectId: "subject-1",
            status: "canceling",
            environment: "test",
            externalOrderId: "provider-order-1",
          }),
        },
      },
      transaction: async <T>(callback: (value: typeof transaction) => Promise<T>) =>
        callback(transaction),
    };

    await expect(
      executeSubscriptionResume({
        database: database as never,
        provider: {
          resumeSubscription: async () => {
            providerCalls += 1;
          },
        } as never,
        job: { id: "job-1", subjectId: "subject-1", targetId: "subscription-1" } as never,
      }),
    ).resolves.toBeUndefined();
    expect(providerCalls).toBe(0);
  });

  it("safely reconciles late subscription resurrection events without retry", () => {
    for (const eventType of [
      "subscription_activated",
      "subscription_payment_succeeded",
      "subscription_uncanceled",
    ] as const) {
      expect(subscriptionEventDisposition("deletion_pending", eventType)).toBe("reconcile");
      expect(subscriptionEventDisposition("deleted", eventType)).toBe("reconcile");
      expect(subscriptionEventDisposition("active", eventType)).toBe("apply");
    }
    expect(subscriptionEventDisposition("deletion_pending", "subscription_canceled")).toBe("apply");
  });

  it("allows only cancellation convergence events after account deletion starts", () => {
    for (const eventType of ["subscription_canceling", "subscription_canceled"] as const) {
      expect(subscriptionEventDisposition("deletion_pending", eventType)).toBe("apply");
      expect(subscriptionEventDisposition("deleted", eventType)).toBe("apply");
    }
    for (const eventType of ["subscription_past_due", "subscription_updated"] as const) {
      expect(subscriptionEventDisposition("deletion_pending", eventType)).toBe("reconcile");
      expect(subscriptionEventDisposition("deleted", eventType)).toBe("reconcile");
      expect(subscriptionEventDisposition("active", eventType)).toBe("apply");
    }
  });

  it("records and consumes a late resurrection event without applying its projection", async () => {
    const outcomes: string[] = [];

    await expect(
      guardSubscriptionEventForSubject({
        subject: { id: "subject-1", status: "deletion_pending" },
        eventType: "subscription_uncanceled",
        reconcile: async () => {
          outcomes.push("reconciled");
        },
        apply: async () => {
          outcomes.push("applied");
        },
      }),
    ).resolves.toBe("reconciled");
    expect(outcomes).toEqual(["reconciled"]);
  });
});
