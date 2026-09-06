import { and, eq, inArray, lte, sql } from "drizzle-orm";

import type { DatabaseClient, DatabaseTransaction } from "@/platform/database/client";
import { commerceReconciliationRuns, orders, payments } from "@/platform/database/commerce-schema";
import { refunds } from "@/platform/database/subscription-schema";

import type { PaymentProvider, ProviderRefundSettlement } from "./payment-provider";
import { applyProviderReadRefundSettlementInTransaction } from "./process-refund-event";

const REFUND_RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const MAX_REFUND_RECONCILIATION_ATTEMPTS = 12;
const MAX_REFUND_RECONCILIATION_BATCH = 20;

type RefundCurrency = "USD" | "EUR" | "GBP" | "SGD" | "AUD" | "CAD" | "JPY" | "KRW";
type RefundDatabase = DatabaseClient | DatabaseTransaction;
type RefundRow = typeof refunds.$inferSelect;

type RefundSettlementCandidate = {
  readonly refund: RefundRow;
  readonly externalPaymentId: string;
  readonly paymentAmount: {
    readonly currency: RefundCurrency;
    readonly minor: bigint;
  };
  readonly orderId: string;
  readonly externalOrderId: string | null;
};

function environment(value: string): "production" | "test" {
  return value === "production" ? "production" : "test";
}

function amount(refund: RefundRow) {
  return {
    currency: refund.currency as RefundCurrency,
    minor: refund.requestedMinor,
  };
}

function retryAt(now: Date): Date {
  return new Date(now.getTime() + REFUND_RECONCILIATION_DELAY_MS);
}

function isRootDatabase(database: RefundDatabase): database is DatabaseClient {
  return "transaction" in database;
}

async function insertReadAudit(
  tx: DatabaseTransaction,
  input: {
    readonly candidate: RefundSettlementCandidate;
    readonly beforeStatus: string;
    readonly beforeWriteState: string;
    readonly result: ProviderRefundSettlement["status"] | "provider_read_failed";
    readonly afterStatus: string;
    readonly reason?: string;
  },
): Promise<void> {
  await tx.insert(commerceReconciliationRuns).values({
    targetType: "payment_refund",
    targetId: input.candidate.refund.id,
    actorType: "provider_read_reconciliation",
    beforeJson: {
      refundId: input.candidate.refund.id,
      status: input.beforeStatus,
      providerWriteState: input.beforeWriteState,
    },
    afterJson: {
      refundId: input.candidate.refund.id,
      status: input.afterStatus,
      providerReadStatus: input.result,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    result: input.result === "succeeded" ? "applied" : "operator_review_required",
  });
}

async function markAmbiguous(
  tx: DatabaseTransaction,
  candidate: RefundSettlementCandidate,
  now: Date,
  reason: string,
  result: ProviderRefundSettlement["status"] | "provider_read_failed",
): Promise<void> {
  await tx
    .update(refunds)
    .set({
      providerWriteState: "ambiguous",
      status: "reconciliation_required",
      reversalStatus: "reconciliation_required",
      operatorReviewReason: reason,
      providerReconciliationAttempts: sql`least(${refunds.providerReconciliationAttempts} + 1, ${MAX_REFUND_RECONCILIATION_ATTEMPTS})`,
      nextProviderReconciliationAt: retryAt(now),
      updatedAt: now,
    })
    .where(eq(refunds.id, candidate.refund.id));
  await insertReadAudit(tx, {
    candidate,
    beforeStatus: candidate.refund.status,
    beforeWriteState: candidate.refund.providerWriteState,
    result,
    afterStatus: "reconciliation_required",
    reason,
  });
}

async function applyReadResult(
  tx: DatabaseTransaction,
  candidate: RefundSettlementCandidate,
  result: ProviderRefundSettlement,
  now: Date,
): Promise<void> {
  const expectedAmount = amount(candidate.refund);
  if (
    result.status === "succeeded" &&
    (!result.amount ||
      result.amount.currency !== expectedAmount.currency ||
      result.amount.minor !== expectedAmount.minor ||
      !result.externalRefundReference)
  ) {
    await markAmbiguous(
      tx,
      candidate,
      now,
      "provider settlement contract mismatch",
      "contract_error",
    );
    return;
  }

  if (result.status === "succeeded") {
    await applyProviderReadRefundSettlementInTransaction(tx, {
      refundId: candidate.refund.id,
      environment: environment(candidate.refund.environment),
      externalPaymentId: candidate.externalPaymentId,
      merchantOrderReference: candidate.orderId,
      ...(result.externalRefundReference
        ? { externalRefundReference: result.externalRefundReference }
        : {}),
      amount: result.amount!,
      occurredAt: now,
    });
    await tx
      .update(refunds)
      .set({
        externalRefundReference: result.externalRefundReference,
        providerWriteState: "confirmed",
        nextProviderReconciliationAt: null,
        operatorReviewReason: null,
        updatedAt: now,
      })
      .where(eq(refunds.id, candidate.refund.id));
    await insertReadAudit(tx, {
      candidate,
      beforeStatus: candidate.refund.status,
      beforeWriteState: candidate.refund.providerWriteState,
      result: result.status,
      afterStatus: "succeeded",
    });
    return;
  }

  if (result.status === "failed") {
    await tx
      .update(refunds)
      .set({
        externalRefundReference: result.externalRefundReference,
        providerWriteState: "confirmed",
        status: "failed",
        reversalStatus: "not_required",
        operatorReviewReason: null,
        nextProviderReconciliationAt: null,
        providerUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(refunds.id, candidate.refund.id));
    await insertReadAudit(tx, {
      candidate,
      beforeStatus: candidate.refund.status,
      beforeWriteState: candidate.refund.providerWriteState,
      result: result.status,
      afterStatus: "failed",
    });
    return;
  }

  if (result.status === "found_pending" || result.status === "found_processing") {
    await tx
      .update(refunds)
      .set({
        externalRefundReference: result.externalRefundReference,
        providerWriteState: "confirmed",
        status: "processing",
        nextProviderReconciliationAt: retryAt(now),
        operatorReviewReason: null,
        providerUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(refunds.id, candidate.refund.id));
    await insertReadAudit(tx, {
      candidate,
      beforeStatus: candidate.refund.status,
      beforeWriteState: candidate.refund.providerWriteState,
      result: result.status,
      afterStatus: "processing",
    });
    return;
  }

  const reason =
    result.status === "not_found"
      ? "provider refund not found during read reconciliation"
      : result.status === "ambiguous"
        ? "provider refund correlation is ambiguous"
        : "provider refund lookup contract mismatch";
  await markAmbiguous(tx, candidate, now, reason, result.status);
}

export async function applyRefundSettlementResultInTransaction(
  tx: DatabaseTransaction,
  candidate: RefundSettlementCandidate,
  result: ProviderRefundSettlement,
  now: Date,
): Promise<void> {
  await applyReadResult(tx, candidate, result, now);
}

export async function reconcileRefundSettlementInTransaction(
  tx: DatabaseTransaction,
  provider: PaymentProvider,
  candidate: RefundSettlementCandidate,
  now: Date,
): Promise<void> {
  let result: ProviderRefundSettlement;
  try {
    result = await provider.getRefundSettlement({
      environment: environment(candidate.refund.environment),
      externalPaymentId: candidate.externalPaymentId,
      ...(candidate.externalOrderId ? { externalOrderId: candidate.externalOrderId } : {}),
      merchantOrderReference: candidate.orderId,
      paymentAmount: candidate.paymentAmount,
      amount: amount(candidate.refund),
      refundIntentReference: candidate.refund.id,
      ...(candidate.refund.externalRefundReference
        ? { externalRefundReference: candidate.refund.externalRefundReference }
        : {}),
    });
  } catch (error) {
    const reason =
      error instanceof Error
        ? `provider refund read failed: ${error.message}`
        : "provider refund read failed";
    await markAmbiguous(tx, candidate, now, reason, "provider_read_failed");
    return;
  }
  await applyReadResult(tx, candidate, result, now);
}

export async function reconcileRefundSettlements(
  database: DatabaseClient,
  provider: PaymentProvider,
  input: { readonly now?: Date; readonly limit?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const limit = Math.min(
    Math.max(input.limit ?? MAX_REFUND_RECONCILIATION_BATCH, 1),
    MAX_REFUND_RECONCILIATION_BATCH,
  );

  if (!isRootDatabase(database))
    throw new Error("refund reconciliation requires a database client");
  return database.transaction(async (tx) => {
    const candidates = await tx
      .select({
        refund: refunds,
        externalPaymentId: payments.externalPaymentId,
        paymentAmount: {
          currency: payments.currency,
          minor: payments.amountMinor,
        },
        orderId: orders.id,
        externalOrderId: orders.externalOrderId,
      })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          inArray(refunds.providerWriteState, ["dispatched", "ambiguous", "confirmed"]),
          inArray(refunds.status, ["processing", "reconciliation_required"]),
          lte(refunds.nextProviderReconciliationAt, now),
        ),
      )
      .orderBy(refunds.nextProviderReconciliationAt, refunds.updatedAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    for (const candidate of candidates) {
      await reconcileRefundSettlementInTransaction(
        tx,
        provider,
        {
          ...candidate,
          paymentAmount: {
            currency: candidate.paymentAmount.currency as RefundCurrency,
            minor: candidate.paymentAmount.minor,
          },
        },
        now,
      );
    }
    return candidates.length;
  });
}

export type { RefundSettlementCandidate };
