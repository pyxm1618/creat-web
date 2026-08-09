import { and, eq, inArray, sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { orders, payments } from "@/platform/database/commerce-schema";
import {
  commerceCommandJobs,
  refunds,
  subscriptions,
} from "@/platform/database/subscription-schema";

import type { Money } from "../domain/money";
import type { CommerceEnvironment } from "../domain/product";

function validateIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9:_-]{16,128}$/.test(value)) {
    throw new Error("invalid commerce idempotency key");
  }
}

export async function enqueueSubscriptionCommand(
  database: DatabaseClient,
  input: {
    readonly subjectId: string;
    readonly subscriptionId: string;
    readonly command: "subscription_cancel" | "subscription_resume";
    readonly idempotencyKey: string;
  },
) {
  validateIdempotencyKey(input.idempotencyKey);
  return database.transaction(async (tx) => {
    const [subscription] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1)
      .for("update");
    if (!subscription || subscription.subjectId !== input.subjectId) {
      throw new Error("subscription not found");
    }

    const existing = await tx.query.commerceCommandJobs.findFirst({
      where: eq(commerceCommandJobs.idempotencyKey, input.idempotencyKey),
    });
    if (existing) {
      if (
        existing.subjectId !== input.subjectId ||
        existing.commandType !== input.command ||
        existing.targetId !== subscription.id
      ) {
        throw new Error("commerce command idempotency collision");
      }
      return existing;
    }

    if (
      input.command === "subscription_cancel" &&
      !["active", "past_due", "canceling"].includes(subscription.status)
    ) {
      throw new Error("subscription cannot be canceled from current state");
    }
    if (input.command === "subscription_resume" && subscription.status !== "canceling") {
      throw new Error("subscription cannot be resumed from current state");
    }

    const [inserted] = await tx
      .insert(commerceCommandJobs)
      .values({
        subjectId: input.subjectId,
        commandType: input.command,
        targetId: subscription.id,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({ target: commerceCommandJobs.idempotencyKey })
      .returning();
    if (inserted) return inserted;

    const raced = await tx.query.commerceCommandJobs.findFirst({
      where: eq(commerceCommandJobs.idempotencyKey, input.idempotencyKey),
    });
    if (
      !raced ||
      raced.subjectId !== input.subjectId ||
      raced.commandType !== input.command ||
      raced.targetId !== subscription.id
    ) {
      throw new Error("commerce command idempotency collision");
    }
    return raced;
  });
}

export async function enqueueRefundRequest(
  database: DatabaseClient,
  input: {
    readonly subjectId: string;
    readonly paymentId: string;
    readonly environment: CommerceEnvironment;
    readonly amount: Money;
    readonly reason: string;
    readonly idempotencyKey: string;
  },
) {
  validateIdempotencyKey(input.idempotencyKey);
  const reason = input.reason.trim().slice(0, 500);
  if (input.amount.minor <= 0n || !reason) throw new Error("invalid refund request");

  return database.transaction(async (tx) => {
    const rows = await tx
      .select({ payment: payments, subjectId: orders.subjectId })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(eq(payments.id, input.paymentId), eq(payments.environment, input.environment)),
      )
      .limit(1)
      .for("update", { of: payments });
    const row = rows[0];
    if (!row || row.subjectId !== input.subjectId) throw new Error("payment not found");

    const existing = await tx.query.refunds.findFirst({
      where: eq(refunds.idempotencyKey, input.idempotencyKey),
    });
    if (existing) {
      if (
        existing.subjectId !== input.subjectId ||
        existing.paymentId !== input.paymentId ||
        existing.environment !== input.environment ||
        existing.requestedMinor !== input.amount.minor ||
        existing.currency !== input.amount.currency ||
        existing.reason !== reason
      ) {
        throw new Error("refund idempotency collision");
      }
      return existing;
    }

    if (row.payment.status !== "succeeded" || row.payment.currency !== input.amount.currency) {
      throw new Error("payment is not refundable");
    }

    const [open] = await tx
      .select({
        total: sql<bigint>`coalesce(sum(${refunds.requestedMinor}), 0)::bigint`,
      })
      .from(refunds)
      .where(
        and(
          eq(refunds.paymentId, row.payment.id),
          inArray(refunds.status, ["pending", "processing"]),
        ),
      );
    const reserved = BigInt(open?.total ?? 0n);
    if (row.payment.refundedMinor + reserved + input.amount.minor > row.payment.amountMinor) {
      throw new Error("refund exceeds refundable amount");
    }

    const [created] = await tx
      .insert(refunds)
      .values({
        paymentId: row.payment.id,
        subjectId: input.subjectId,
        environment: input.environment,
        idempotencyKey: input.idempotencyKey,
        currency: input.amount.currency,
        requestedMinor: input.amount.minor,
        reason,
      })
      .onConflictDoNothing({ target: refunds.idempotencyKey })
      .returning();
    const refund =
      created ??
      (await tx.query.refunds.findFirst({
        where: eq(refunds.idempotencyKey, input.idempotencyKey),
      }));
    if (
      !refund ||
      refund.subjectId !== input.subjectId ||
      refund.paymentId !== input.paymentId ||
      refund.environment !== input.environment ||
      refund.requestedMinor !== input.amount.minor ||
      refund.currency !== input.amount.currency ||
      refund.reason !== reason
    ) {
      throw new Error("refund idempotency collision");
    }

    await tx
      .insert(commerceCommandJobs)
      .values({
        subjectId: input.subjectId,
        commandType: "refund_request",
        targetId: refund.id,
        idempotencyKey: `command:${input.idempotencyKey}`,
      })
      .onConflictDoNothing({ target: commerceCommandJobs.idempotencyKey });
    return refund;
  });
}
