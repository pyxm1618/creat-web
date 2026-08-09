import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { reconcileStaleRefunds } from "@/platform/commerce/application/reconcile-stale-refunds";
import { createDatabaseClient } from "@/platform/database/client";
import {
  accountSubjects,
  commerceProducts,
  commerceReconciliationRuns,
  orders,
  payments,
  refunds,
} from "@/platform/database/schema";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabaseClient(databaseUrl);

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

afterAll(async () => database.close());

it("moves provider-accepted refunds with no settlement webhook into operator reconciliation", async () => {
  const [subject] = await database.db.insert(accountSubjects).values({}).returning();
  if (!subject) throw new Error("subject insert failed");
  const [product] = await database.db
    .insert(commerceProducts)
    .values({
      key: `refund-reconcile-${crypto.randomUUID()}`,
      version: 1,
      model: "one_time",
      billingInterval: null,
      environment: "test",
      providerProductId: `PROD_${crypto.randomUUID()}`,
      currency: "USD",
      expectedMinor: 1000n,
      fulfillmentKey: "refund-reconcile",
      refundPolicyKey: "default",
    })
    .returning();
  if (!product) throw new Error("product insert failed");
  const [order] = await database.db
    .insert(orders)
    .values({
      subjectId: subject.id,
      productId: product.id,
      environment: "test",
      status: "paid",
      expectedCurrency: "USD",
      expectedMinor: 1000n,
      checkoutIdempotencyKey: `checkout:${crypto.randomUUID()}`,
      checkoutState: "created",
      externalOrderId: `ORD_${crypto.randomUUID()}`,
    })
    .returning();
  if (!order) throw new Error("order insert failed");
  const [payment] = await database.db
    .insert(payments)
    .values({
      orderId: order.id,
      environment: "test",
      externalPaymentId: `PAY_${crypto.randomUUID()}`,
      status: "succeeded",
      refundStatus: "none",
      currency: "USD",
      amountMinor: 1000n,
      refundedMinor: 0n,
      rawPayloadHash: "a".repeat(64),
    })
    .returning();
  if (!payment) throw new Error("payment insert failed");

  const staleAt = new Date("2026-08-08T00:00:00Z");
  const [refund] = await database.db
    .insert(refunds)
    .values({
      paymentId: payment.id,
      subjectId: subject.id,
      environment: "test",
      externalRefundReference: `REF_${crypto.randomUUID()}`,
      idempotencyKey: `refund:${crypto.randomUUID()}`,
      currency: "USD",
      requestedMinor: 1000n,
      reason: "customer request",
      status: "processing",
      updatedAt: staleAt,
    })
    .returning();
  if (!refund) throw new Error("refund insert failed");

  const now = new Date("2026-08-10T00:00:00Z");
  expect(await reconcileStaleRefunds(database.db, { now, staleAfterMs: 24 * 60 * 60 * 1000 })).toBe(1);
  expect(await reconcileStaleRefunds(database.db, { now, staleAfterMs: 24 * 60 * 60 * 1000 })).toBe(0);

  const persisted = await database.db.query.refunds.findFirst({ where: eq(refunds.id, refund.id) });
  expect(persisted?.status).toBe("reconciliation_required");
  expect(persisted?.reversalStatus).toBe("reconciliation_required");
  expect(persisted?.operatorReviewReason).toContain("settlement webhook");

  const evidence = await database.db
    .select()
    .from(commerceReconciliationRuns)
    .where(eq(commerceReconciliationRuns.targetId, payment.id));
  expect(evidence).toHaveLength(1);
  expect(evidence[0]?.result).toBe("operator_review_required");
});
