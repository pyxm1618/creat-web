import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createAccountDeletionService } from "@/platform/accounts/account-deletion-service";
import { createPlatformAccountDeletionCoordinator } from "@/platform/accounts/platform-account-deletion-coordinator";
import { createPostgresAccountSubjectRepository } from "@/platform/accounts/postgres-account-subject-repository";
import { enqueueSubscriptionCommand } from "@/platform/commerce/application/commerce-commands";
import type { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountDeletionRequests,
  commerceCommandJobs,
  commerceProducts,
  orders,
  subscriptions,
  user,
} from "@/platform/database/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const database = createDatabaseClient(databaseUrl);
const subjects = createPostgresAccountSubjectRepository(database.db);
type CommerceRuntime = NonNullable<Awaited<ReturnType<typeof getCommerceRuntime>>>;

async function seedSubscription(subjectId: string, key: string) {
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `coordinator-${key}`,
      version: 1,
      model: "subscription",
      billingInterval: "month",
      environment: "test",
      providerProductId: `provider-${key}`,
      currency: "USD",
      expectedMinor: 1000n,
      fulfillmentKey: "none",
      refundPolicyKey: "standard",
    })
    .returning();
  if (!product) throw new Error("product seed failed");
  const [order] = await database.db
    .insert(orders)
    .values({
      subjectId,
      productId: product.id,
      environment: "test",
      expectedCurrency: "USD",
      expectedMinor: 1000n,
      checkoutIdempotencyKey: `coordinator-checkout:${key}`,
    })
    .returning();
  if (!order) throw new Error("order seed failed");
  const [subscription] = await database.db
    .insert(subscriptions)
    .values({
      orderId: order.id,
      subjectId,
      environment: "test",
      externalOrderId: `external-${key}`,
      status: "active",
    })
    .returning();
  if (!subscription) throw new Error("subscription seed failed");
  return subscription;
}

async function seedActiveSubscription(authUserId: string) {
  const timestamp = new Date();
  await database.db.insert(user).values({
    id: authUserId,
    name: "Coordinator Test",
    email: `${authUserId}@example.com`,
    emailVerified: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const subject = await subjects.ensureForAuthUser(authUserId);
  const subscription = await seedSubscription(subject.id, authUserId);
  return { subject, subscription };
}

function availableCommerceRuntime() {
  return async () => ({ database: database.db }) as CommerceRuntime;
}

beforeAll(async () => {
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS public CASCADE"));
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS drizzle CASCADE"));
  await database.db.execute(sql.raw("CREATE SCHEMA public"));
  await migrate(database.db, {
    migrationsFolder: "drizzle",
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
});

afterAll(async () => {
  await database.close();
});

describe("durable account deletion worker", () => {
  it("returns immediately when Commerce is unavailable", async () => {
    const coordinator = createPlatformAccountDeletionCoordinator({
      database: undefined as never,
      getCommerce: async () => null,
    });

    await expect(
      coordinator.prepare({ subjectId: randomUUID(), operationKey: "" }),
    ).resolves.toBeUndefined();
  });

  it("enqueues one deterministic cancel command and waits until preparation completes", async () => {
    const { subject, subscription } = await seedActiveSubscription("coordinator_pending_user");
    await subjects.beginDeletion(subject.id);
    const operationKey = randomUUID();
    const idempotencyKey = `account-delete:${operationKey}:${subscription.id}`;
    const coordinator = createPlatformAccountDeletionCoordinator({
      database: database.db,
      getCommerce: availableCommerceRuntime(),
    });

    await expect(coordinator.prepare({ subjectId: subject.id, operationKey })).rejects.toThrow(
      "commerce account deletion preparation pending",
    );
    await expect(coordinator.prepare({ subjectId: subject.id, operationKey })).rejects.toThrow(
      "commerce account deletion preparation pending",
    );
    let commands = await database.db
      .select()
      .from(commerceCommandJobs)
      .where(eq(commerceCommandJobs.idempotencyKey, idempotencyKey));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      subjectId: subject.id,
      targetId: subscription.id,
      commandType: "subscription_cancel",
      state: "pending",
    });

    await database.db
      .update(commerceCommandJobs)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(commerceCommandJobs.idempotencyKey, idempotencyKey));
    await database.db
      .update(subscriptions)
      .set({ status: "canceling" })
      .where(eq(subscriptions.id, subscription.id));

    await expect(
      coordinator.prepare({ subjectId: subject.id, operationKey }),
    ).resolves.toBeUndefined();
    await expect(
      coordinator.prepare({ subjectId: subject.id, operationKey }),
    ).resolves.toBeUndefined();
    commands = await database.db
      .select()
      .from(commerceCommandJobs)
      .where(eq(commerceCommandJobs.idempotencyKey, idempotencyKey));
    expect(commands).toHaveLength(1);
  });

  it("enqueues every active subscription before reporting preparation pending", async () => {
    const { subject, subscription } = await seedActiveSubscription("coordinator_many_user");
    const secondSubscription = await seedSubscription(subject.id, "coordinator_many_second");
    await subjects.beginDeletion(subject.id);
    const operationKey = randomUUID();
    const coordinator = createPlatformAccountDeletionCoordinator({
      database: database.db,
      getCommerce: availableCommerceRuntime(),
    });

    await expect(coordinator.prepare({ subjectId: subject.id, operationKey })).rejects.toThrow(
      "commerce account deletion preparation pending",
    );

    const commands = await database.db
      .select()
      .from(commerceCommandJobs)
      .where(eq(commerceCommandJobs.subjectId, subject.id));
    expect(commands).toHaveLength(2);
    expect(new Set(commands.map((command) => command.idempotencyKey))).toEqual(
      new Set([
        `account-delete:${operationKey}:${subscription.id}`,
        `account-delete:${operationKey}:${secondSubscription.id}`,
      ]),
    );
  });

  it("requires operator review when a cancellation command is dead-lettered", async () => {
    const { subject, subscription } = await seedActiveSubscription("coordinator_dead_letter_user");
    await subjects.beginDeletion(subject.id);
    const operationKey = randomUUID();
    const idempotencyKey = `account-delete:${operationKey}:${subscription.id}`;
    const coordinator = createPlatformAccountDeletionCoordinator({
      database: database.db,
      getCommerce: availableCommerceRuntime(),
    });

    await expect(coordinator.prepare({ subjectId: subject.id, operationKey })).rejects.toThrow(
      "commerce account deletion preparation pending",
    );
    await database.db
      .update(commerceCommandJobs)
      .set({ state: "dead_letter" })
      .where(eq(commerceCommandJobs.idempotencyKey, idempotencyKey));

    await expect(coordinator.prepare({ subjectId: subject.id, operationKey })).rejects.toThrow(
      "commerce account deletion requires operator review",
    );
  });

  it("creates a durable cancellation command for a pending subscription", async () => {
    const { subject, subscription } = await seedActiveSubscription("coordinator_pending_state");
    await database.db
      .update(subscriptions)
      .set({ status: "pending" })
      .where(eq(subscriptions.id, subscription.id));
    await subjects.beginDeletion(subject.id);
    const operationKey = randomUUID();
    const coordinator = createPlatformAccountDeletionCoordinator({
      database: database.db,
      getCommerce: availableCommerceRuntime(),
    });

    await expect(coordinator.prepare({ subjectId: subject.id, operationKey })).rejects.toThrow(
      "commerce account deletion preparation pending",
    );
    const commands = await database.db
      .select()
      .from(commerceCommandJobs)
      .where(
        eq(commerceCommandJobs.idempotencyKey, `account-delete:${operationKey}:${subscription.id}`),
      );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ commandType: "subscription_cancel", state: "pending" });
  });

  it("holds the subject fence through the final scan and rejects a racing resume", async () => {
    const { subject, subscription } = await seedActiveSubscription("coordinator_final_scan");
    await subjects.beginDeletion(subject.id);
    const operationKey = randomUUID();
    const idempotencyKey = `account-delete:${operationKey}:${subscription.id}`;
    const coordinator = createPlatformAccountDeletionCoordinator({
      database: database.db,
      getCommerce: availableCommerceRuntime(),
    });
    await expect(coordinator.prepare({ subjectId: subject.id, operationKey })).rejects.toThrow(
      "commerce account deletion preparation pending",
    );
    await database.db
      .update(commerceCommandJobs)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(commerceCommandJobs.idempotencyKey, idempotencyKey));
    await database.db
      .update(subscriptions)
      .set({ status: "canceling", cancelAtPeriodEnd: true })
      .where(eq(subscriptions.id, subscription.id));

    let releaseSubscription!: () => void;
    const subscriptionGate = new Promise<void>((resolve) => {
      releaseSubscription = resolve;
    });
    let subscriptionLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      subscriptionLocked = resolve;
    });
    const blocker = database.db.transaction(async (transaction) => {
      await transaction
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subscription.id))
        .for("update");
      subscriptionLocked();
      await subscriptionGate;
    });
    await locked;

    const finalScan = coordinator.prepare({ subjectId: subject.id, operationKey });
    const scanBeforeRelease = await Promise.race([
      finalScan.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 75)),
    ]);
    expect(scanBeforeRelease).toBe("blocked");
    const resume = enqueueSubscriptionCommand(database.db, {
      subjectId: subject.id,
      subscriptionId: subscription.id,
      command: "subscription_resume",
      idempotencyKey: `resume:${randomUUID()}`,
    });

    releaseSubscription();
    await blocker;
    await expect(finalScan).resolves.toBeUndefined();
    await expect(resume).rejects.toThrow("account deletion prevents subscription resume");
    expect(
      await database.db.query.subscriptions.findFirst({
        where: eq(subscriptions.id, subscription.id),
      }),
    ).toMatchObject({ status: "canceling" });
  });

  it("claims a failed due job and completes it without another user request", async () => {
    const authUserId = "worker_retry_user";
    const timestamp = new Date();
    await database.db.insert(user).values({
      id: authUserId,
      name: "Worker Retry",
      email: "worker-retry@example.com",
      emailVerified: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const subject = await subjects.ensureForAuthUser(authUserId);

    let prepareCalls = 0;
    let clock = new Date("2030-08-07T04:00:00Z").getTime();
    const service = createAccountDeletionService({
      database: database.db,
      subjects,
      coordinator: {
        prepare: async () => {
          prepareCalls += 1;
          if (prepareCalls === 1) throw new Error("temporary dependency failure");
        },
      },
      identityDeletion: {
        deleteUser: async (userId) => {
          await database.db.delete(user).where(eq(user.id, userId));
        },
      },
      now: () => new Date((clock += 60_000)),
    });

    const request = await service.request({ subjectId: subject.id, authUserId });
    await expect(service.run(request.id)).rejects.toThrow("account deletion failed");

    const result = await service.runDueBatch(5);
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(prepareCalls).toBe(2);

    const rows = await database.db
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, request.id));
    expect(rows[0]?.status).toBe("completed");
  });
});
