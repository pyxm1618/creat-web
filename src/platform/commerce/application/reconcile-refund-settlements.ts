import { and, eq, inArray, isNull, lte, lt, or, sql } from "drizzle-orm";

import type { DatabaseClient, DatabaseTransaction } from "@/platform/database/client";
import { commerceReconciliationRuns, orders, payments } from "@/platform/database/commerce-schema";
import { refunds } from "@/platform/database/subscription-schema";

import type { PaymentProvider, ProviderRefundSettlement } from "./payment-provider";
import { applyProviderReadRefundSettlementInTransaction } from "./process-refund-event";
import {
  PROVIDER_SETTLEMENT_ALREADY_APPLIED_REASON,
  REFUND_SETTLEMENT_WEBHOOK_TIMEOUT_REASON,
} from "../domain/refund";

const REFUND_RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const MAX_REFUND_RECONCILIATION_ATTEMPTS = 12;
const MAX_REFUND_RECONCILIATION_BATCH = 20;
const MIN_REFUND_LOOKUP_REMAINING_MS = 6_000;
const REFUND_RECONCILIATION_LEASE_MS = 30_000;

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
  readonly sourceState: {
    readonly refundStatus: string;
    readonly providerWriteState: string;
    readonly reversalStatus: string;
    readonly succeededMinor: bigint;
    readonly externalRefundReference: string | null;
    readonly externalSettlementReference: string | null;
    readonly nextProviderReconciliationAt: Date | null;
    readonly reconciliationLeaseOwner: string | null;
    readonly reconciliationLeaseExpiresAt: Date | null;
    readonly paymentRefundStatus: string;
    readonly paymentRefundedMinor: bigint;
    readonly orderStatus: string;
  };
};

type ProviderReadResult =
  | ProviderRefundSettlement
  | { readonly status: "provider_read_failed"; readonly reason: string };

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

function leaseUntil(now: Date): Date {
  return new Date(now.getTime() + REFUND_RECONCILIATION_LEASE_MS);
}

function sameDate(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
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
    readonly result: ProviderReadResult["status"];
    readonly afterStatus: string;
    readonly reason?: string;
    readonly auditResult?: string;
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
    result:
      input.auditResult ?? (input.result === "succeeded" ? "applied" : "operator_review_required"),
  });
}

async function markAmbiguous(
  tx: DatabaseTransaction,
  candidate: RefundSettlementCandidate,
  now: Date,
  reason: string,
  result: ProviderReadResult["status"],
): Promise<void> {
  await tx
    .update(refunds)
    .set({
      providerWriteState: "ambiguous",
      status: "reconciliation_required",
      reversalStatus: "reconciliation_required",
      operatorReviewReason: reason,
      providerReconciliationAttempts: sql`least(${refunds.providerReconciliationAttempts} + 1, ${MAX_REFUND_RECONCILIATION_ATTEMPTS})`,
      nextProviderReconciliationAt: sql`case when ${refunds.providerReconciliationAttempts} >= ${MAX_REFUND_RECONCILIATION_ATTEMPTS - 1} then null else ${retryAt(now).toISOString()}::timestamptz end`,
      reconciliationLeaseOwner: null,
      reconciliationLeaseExpiresAt: null,
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
  result: ProviderReadResult,
  now: Date,
): Promise<void> {
  if (result.status === "provider_read_failed") {
    await markAmbiguous(tx, candidate, now, result.reason, result.status);
    return;
  }

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
    const [projectedRefund] = await tx
      .select({ operatorReviewReason: refunds.operatorReviewReason })
      .from(refunds)
      .where(eq(refunds.id, candidate.refund.id))
      .limit(1);
    if (!projectedRefund) throw new Error("refund settlement projection disappeared");
    await tx
      .update(refunds)
      .set({
        externalRefundReference: result.externalRefundReference,
        ...(result.externalSettlementReference
          ? { externalSettlementReference: result.externalSettlementReference }
          : {}),
        providerWriteState: "confirmed",
        nextProviderReconciliationAt: null,
        reconciliationLeaseOwner: null,
        reconciliationLeaseExpiresAt: null,
        operatorReviewReason: projectedRefund.operatorReviewReason,
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
        ...(result.externalSettlementReference
          ? { externalSettlementReference: result.externalSettlementReference }
          : {}),
        providerWriteState: "confirmed",
        status: "failed",
        reversalStatus: "not_required",
        operatorReviewReason: null,
        nextProviderReconciliationAt: null,
        reconciliationLeaseOwner: null,
        reconciliationLeaseExpiresAt: null,
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
    const staleEscalated =
      candidate.refund.operatorReviewReason === REFUND_SETTLEMENT_WEBHOOK_TIMEOUT_REASON;
    await tx
      .update(refunds)
      .set({
        externalRefundReference: result.externalRefundReference,
        ...(result.externalSettlementReference
          ? { externalSettlementReference: result.externalSettlementReference }
          : {}),
        providerWriteState: "confirmed",
        status: staleEscalated ? "reconciliation_required" : "processing",
        nextProviderReconciliationAt: staleEscalated ? null : retryAt(now),
        reconciliationLeaseOwner: null,
        reconciliationLeaseExpiresAt: null,
        operatorReviewReason: staleEscalated ? REFUND_SETTLEMENT_WEBHOOK_TIMEOUT_REASON : null,
        providerUpdatedAt: now,
      })
      .where(eq(refunds.id, candidate.refund.id));
    await insertReadAudit(tx, {
      candidate,
      beforeStatus: candidate.refund.status,
      beforeWriteState: candidate.refund.providerWriteState,
      result: result.status,
      afterStatus: staleEscalated ? "reconciliation_required" : "processing",
      ...(staleEscalated ? { reason: REFUND_SETTLEMENT_WEBHOOK_TIMEOUT_REASON } : {}),
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

async function reloadRefundSettlementState(
  tx: DatabaseTransaction,
  candidate: RefundSettlementCandidate,
) {
  const [payment] = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, candidate.refund.paymentId))
    .limit(1)
    .for("update");
  if (!payment) return undefined;

  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, payment.orderId))
    .limit(1)
    .for("update");
  if (!order) return undefined;

  const [refund] = await tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.id, candidate.refund.id), eq(refunds.paymentId, payment.id)))
    .limit(1)
    .for("update");
  if (!refund) return undefined;

  return {
    refund,
    paymentRefundStatus: payment.refundStatus,
    paymentRefundedMinor: payment.refundedMinor,
    orderStatus: order.status,
  };
}

type CurrentRefundSettlementState = NonNullable<
  Awaited<ReturnType<typeof reloadRefundSettlementState>>
>;

function matchesSourceState(
  candidate: RefundSettlementCandidate,
  current: CurrentRefundSettlementState,
  now: Date,
): boolean {
  return (
    current.refund.status === candidate.sourceState.refundStatus &&
    current.refund.providerWriteState === candidate.sourceState.providerWriteState &&
    current.refund.reversalStatus === candidate.sourceState.reversalStatus &&
    current.refund.succeededMinor === candidate.sourceState.succeededMinor &&
    current.refund.externalRefundReference === candidate.sourceState.externalRefundReference &&
    current.refund.externalSettlementReference ===
      candidate.sourceState.externalSettlementReference &&
    sameDate(
      current.refund.nextProviderReconciliationAt,
      candidate.sourceState.nextProviderReconciliationAt,
    ) &&
    current.refund.reconciliationLeaseOwner === candidate.sourceState.reconciliationLeaseOwner &&
    sameDate(
      current.refund.reconciliationLeaseExpiresAt,
      candidate.sourceState.reconciliationLeaseExpiresAt,
    ) &&
    (candidate.sourceState.reconciliationLeaseOwner === null ||
      (candidate.sourceState.reconciliationLeaseExpiresAt !== null &&
        candidate.sourceState.reconciliationLeaseExpiresAt > now)) &&
    current.paymentRefundStatus === candidate.sourceState.paymentRefundStatus &&
    current.paymentRefundedMinor === candidate.sourceState.paymentRefundedMinor &&
    current.orderStatus === candidate.sourceState.orderStatus
  );
}

function reflectsAuthoritativeSettlement(
  candidate: RefundSettlementCandidate,
  current: CurrentRefundSettlementState,
): boolean {
  const remainingPaymentMinor = candidate.paymentAmount.minor - current.paymentRefundedMinor;
  return (
    current.refund.status === "succeeded" ||
    current.refund.reversalStatus === "completed" ||
    current.paymentRefundStatus === "refunded" ||
    current.orderStatus === "refunded" ||
    remainingPaymentMinor < candidate.refund.requestedMinor
  );
}

async function ignoreStaleProviderRead(
  tx: DatabaseTransaction,
  candidate: RefundSettlementCandidate,
  current: CurrentRefundSettlementState,
  result: ProviderReadResult,
  now: Date,
  retireCandidate: boolean,
): Promise<void> {
  if (retireCandidate) {
    await tx
      .update(refunds)
      .set({
        nextProviderReconciliationAt: null,
        reconciliationLeaseOwner: null,
        reconciliationLeaseExpiresAt: null,
        operatorReviewReason:
          current.refund.status === "succeeded"
            ? null
            : "provider read ignored because authoritative local refund state changed before apply",
        updatedAt: now,
      })
      .where(eq(refunds.id, candidate.refund.id));
  }
  await insertReadAudit(tx, {
    candidate,
    beforeStatus: candidate.refund.status,
    beforeWriteState: candidate.refund.providerWriteState,
    result: result.status,
    afterStatus: current.refund.status,
    reason: "provider read ignored because authoritative local refund state changed before apply",
    auditResult: "stale_provider_read_ignored",
  });
}

async function ignoreAlreadyProjectedProviderSettlement(
  tx: DatabaseTransaction,
  candidate: RefundSettlementCandidate,
  current: CurrentRefundSettlementState,
  result: ProviderReadResult,
  now: Date,
): Promise<boolean> {
  if (
    result.status !== "succeeded" ||
    !result.amount ||
    !result.externalRefundReference ||
    !result.externalSettlementReference ||
    result.amount.currency !== candidate.refund.currency ||
    result.amount.minor !== candidate.refund.requestedMinor
  ) {
    return false;
  }

  const projectedSettlements = await tx
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.environment, candidate.refund.environment),
        or(
          eq(refunds.externalRefundReference, result.externalSettlementReference),
          eq(refunds.externalSettlementReference, result.externalSettlementReference),
        ),
      ),
    )
    .limit(2)
    .for("update");
  if (projectedSettlements.length === 0) return false;

  const [projectedSettlement] = projectedSettlements;
  if (projectedSettlements.length > 1 || !projectedSettlement) {
    if (matchesSourceState(candidate, current, now)) {
      await markAmbiguous(
        tx,
        candidate,
        now,
        "provider settlement identity matches multiple local refunds",
        "contract_error",
      );
    } else {
      await ignoreStaleProviderRead(tx, candidate, current, result, now, false);
    }
    return true;
  }

  if (projectedSettlement.id === candidate.refund.id) return false;

  if (
    projectedSettlement.paymentId === candidate.refund.paymentId &&
    projectedSettlement.status === "succeeded" &&
    projectedSettlement.currency === result.amount.currency &&
    projectedSettlement.succeededMinor === result.amount.minor
  ) {
    await tx
      .update(refunds)
      .set({
        nextProviderReconciliationAt: null,
        reconciliationLeaseOwner: null,
        reconciliationLeaseExpiresAt: null,
        operatorReviewReason: PROVIDER_SETTLEMENT_ALREADY_APPLIED_REASON,
        updatedAt: now,
      })
      .where(eq(refunds.id, candidate.refund.id));
    await insertReadAudit(tx, {
      candidate,
      beforeStatus: candidate.refund.status,
      beforeWriteState: candidate.refund.providerWriteState,
      result: result.status,
      afterStatus: current.refund.status,
      reason: PROVIDER_SETTLEMENT_ALREADY_APPLIED_REASON,
      auditResult: "provider_settlement_already_applied",
    });
    return true;
  }

  if (matchesSourceState(candidate, current, now)) {
    await markAmbiguous(
      tx,
      candidate,
      now,
      "provider settlement identity conflicts with another local refund",
      "contract_error",
    );
  } else {
    await ignoreStaleProviderRead(tx, candidate, current, result, now, false);
  }
  return true;
}

export async function applyRefundSettlementResultInTransaction(
  tx: DatabaseTransaction,
  candidate: RefundSettlementCandidate,
  result: ProviderReadResult,
  now: Date,
): Promise<void> {
  const current = await reloadRefundSettlementState(tx, candidate);
  if (!current) throw new Error("refund settlement target disappeared");
  if (await ignoreAlreadyProjectedProviderSettlement(tx, candidate, current, result, now)) return;
  if (reflectsAuthoritativeSettlement(candidate, current)) {
    await ignoreStaleProviderRead(tx, candidate, current, result, now, true);
    return;
  }
  if (!matchesSourceState(candidate, current, now)) {
    await ignoreStaleProviderRead(tx, candidate, current, result, now, false);
    return;
  }
  await applyReadResult(tx, { ...candidate, refund: current.refund }, result, now);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function awaitProviderLookup<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      queueMicrotask(() => reject(signal.reason ?? new DOMException("aborted", "AbortError")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(error);
      return;
    }
    result.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted && isAbortError(error) ? (signal.reason ?? error) : error);
      },
    );
  });
}

async function lookupRefundSettlement(
  provider: PaymentProvider,
  candidate: RefundSettlementCandidate,
  signal?: AbortSignal,
): Promise<ProviderReadResult> {
  try {
    return await awaitProviderLookup(
      () =>
        provider.getRefundSettlement({
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
          ...(signal ? { signal } : {}),
        }),
      signal,
    );
  } catch (error) {
    if (signal?.aborted || error === signal?.reason || isAbortError(error)) throw error;
    return {
      status: "provider_read_failed",
      reason:
        error instanceof Error
          ? `provider refund read failed: ${error.message}`
          : "provider refund read failed",
    };
  }
}

function candidateFromRow(row: {
  readonly refund: RefundRow;
  readonly externalPaymentId: string;
  readonly paymentAmount: { readonly currency: string; readonly minor: bigint };
  readonly paymentRefundStatus: string;
  readonly paymentRefundedMinor: bigint;
  readonly orderId: string;
  readonly orderStatus: string;
  readonly externalOrderId: string | null;
}): RefundSettlementCandidate {
  return {
    ...row,
    paymentAmount: {
      currency: row.paymentAmount.currency as RefundCurrency,
      minor: row.paymentAmount.minor,
    },
    sourceState: {
      refundStatus: row.refund.status,
      providerWriteState: row.refund.providerWriteState,
      reversalStatus: row.refund.reversalStatus,
      succeededMinor: row.refund.succeededMinor,
      externalRefundReference: row.refund.externalRefundReference,
      externalSettlementReference: row.refund.externalSettlementReference,
      nextProviderReconciliationAt: row.refund.nextProviderReconciliationAt,
      reconciliationLeaseOwner: row.refund.reconciliationLeaseOwner,
      reconciliationLeaseExpiresAt: row.refund.reconciliationLeaseExpiresAt,
      paymentRefundStatus: row.paymentRefundStatus,
      paymentRefundedMinor: row.paymentRefundedMinor,
      orderStatus: row.orderStatus,
    },
  };
}

export async function reconcileRefundSettlements(
  database: DatabaseClient,
  provider: PaymentProvider,
  input: {
    readonly now?: Date;
    readonly limit?: number;
    readonly signal?: AbortSignal;
    readonly canContinue?: (minimumRemainingMs?: number) => boolean;
  } = {},
): Promise<number> {
  input.signal?.throwIfAborted();
  const now = input.now ?? new Date();
  const limit = Math.min(
    Math.max(input.limit ?? MAX_REFUND_RECONCILIATION_BATCH, 1),
    MAX_REFUND_RECONCILIATION_BATCH,
  );

  if (!isRootDatabase(database))
    throw new Error("refund reconciliation requires a database client");
  const leaseOwner = crypto.randomUUID();
  const leaseExpiresAt = leaseUntil(now);
  const candidates = await database.transaction(async (tx) => {
    input.signal?.throwIfAborted();
    const rows = await tx
      .select({
        refund: refunds,
        externalPaymentId: payments.externalPaymentId,
        paymentAmount: {
          currency: payments.currency,
          minor: payments.amountMinor,
        },
        paymentRefundStatus: payments.refundStatus,
        paymentRefundedMinor: payments.refundedMinor,
        orderId: orders.id,
        orderStatus: orders.status,
        externalOrderId: orders.externalOrderId,
      })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          inArray(refunds.providerWriteState, ["dispatched", "ambiguous", "confirmed"]),
          inArray(refunds.status, ["processing", "reconciliation_required"]),
          lt(refunds.providerReconciliationAttempts, MAX_REFUND_RECONCILIATION_ATTEMPTS),
          lte(refunds.nextProviderReconciliationAt, now),
          or(
            isNull(refunds.reconciliationLeaseOwner),
            isNull(refunds.reconciliationLeaseExpiresAt),
            lte(refunds.reconciliationLeaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(refunds.nextProviderReconciliationAt, refunds.updatedAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    const candidates: RefundSettlementCandidate[] = [];
    for (const row of rows) {
      const [claimedRefund] = await tx
        .update(refunds)
        .set({
          nextProviderReconciliationAt: leaseExpiresAt,
          reconciliationLeaseOwner: leaseOwner,
          reconciliationLeaseExpiresAt: leaseExpiresAt,
        })
        .where(
          and(
            eq(refunds.id, row.refund.id),
            or(
              isNull(refunds.reconciliationLeaseOwner),
              isNull(refunds.reconciliationLeaseExpiresAt),
              lte(refunds.reconciliationLeaseExpiresAt, now),
            ),
          ),
        )
        .returning();
      if (claimedRefund) {
        candidates.push(candidateFromRow({ ...row, refund: claimedRefund }));
      }
    }
    return candidates;
  });

  let reconciled = 0;
  for (const candidate of candidates) {
    if (input.signal?.aborted) {
      if (reconciled > 0) break;
      input.signal.throwIfAborted();
    }
    if (input.canContinue && !input.canContinue(MIN_REFUND_LOOKUP_REMAINING_MS)) break;

    const result = await lookupRefundSettlement(provider, candidate, input.signal);
    if (input.signal?.aborted) {
      if (reconciled > 0) break;
      input.signal.throwIfAborted();
    }
    await database.transaction(async (tx) => {
      await applyRefundSettlementResultInTransaction(tx, candidate, result, now);
    });
    reconciled += 1;
  }
  return reconciled;
}

export type { RefundSettlementCandidate };
