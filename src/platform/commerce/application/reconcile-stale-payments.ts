import { createHash } from "node:crypto";

import { and, eq, isNull, lte } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
  commerceReconciliationRuns,
  commerceProducts,
  orders,
  paymentReconciliationJobs,
} from "@/platform/database/commerce-schema";

import { currencyExponent, type SupportedCurrency } from "../domain/money";
import type { CommerceEnvironment, CommercialModel } from "../domain/product";
import {
  acquirePaymentReconciliationFence,
  claimPaymentReconciliationJobs,
  completePaymentReconciliationJobInTransaction,
  operatorReviewPaymentReconciliationJob,
  operatorReviewPaymentReconciliationJobInTransaction,
  retryPaymentReconciliationJob,
} from "./job-leases";
import type { PaymentLookupResult, PaymentProvider } from "./payment-provider";
import { validateProviderQueryWarnings } from "./provider-query-warnings";
import { processProviderEventInTransaction } from "./process-provider-event";

const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

export type SeededPaymentReconciliationJob = {
  readonly orderId: string;
  readonly environment: CommerceEnvironment;
  readonly externalOrderId: string | null;
  readonly model: CommercialModel;
  readonly currency: SupportedCurrency;
  readonly amountMinor: bigint;
  readonly fulfillmentKey: string;
};

export type SeedPaymentReconciliationResult = {
  readonly scanned: number;
  readonly seeded: number;
  readonly jobs: readonly SeededPaymentReconciliationJob[];
};

export type PaymentReconciliationResult = {
  readonly scanned: number;
  readonly applied: number;
  readonly retried: number;
  readonly operatorReview: number;
};

function parseEnvironment(value: string): CommerceEnvironment {
  if (value === "test" || value === "production") return value;
  throw new Error(`invalid order environment: ${value}`);
}

function parseModel(value: string): CommercialModel {
  if (value === "one_time" || value === "subscription") return value;
  throw new Error(`invalid product model: ${value}`);
}

function parseCurrency(value: string): SupportedCurrency {
  currencyExponent(value);
  return value.toUpperCase() as SupportedCurrency;
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

export async function seedPaymentReconciliationJobs(
  database: DatabaseClient,
  input: {
    readonly now?: Date;
    readonly staleAfterMs?: number;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<SeedPaymentReconciliationResult> {
  input.signal?.throwIfAborted();
  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error("stale payment threshold must be positive");
  }
  const cutoff = new Date(now.getTime() - staleAfterMs);

  return database.transaction(async (tx) => {
    input.signal?.throwIfAborted();
    const candidates = await tx
      .select({
        orderId: orders.id,
        environment: orders.environment,
        externalOrderId: orders.externalOrderId,
        model: commerceProducts.model,
        currency: orders.expectedCurrency,
        amountMinor: orders.expectedMinor,
        fulfillmentKey: commerceProducts.fulfillmentKey,
      })
      .from(orders)
      .innerJoin(commerceProducts, eq(commerceProducts.id, orders.productId))
      .leftJoin(paymentReconciliationJobs, eq(paymentReconciliationJobs.orderId, orders.id))
      .where(
        and(
          eq(orders.checkoutState, "created"),
          eq(orders.status, "pending"),
          lte(orders.createdAt, cutoff),
          isNull(paymentReconciliationJobs.id),
        ),
      )
      .orderBy(orders.createdAt, orders.id)
      .limit(limit);
    input.signal?.throwIfAborted();

    const jobs: SeededPaymentReconciliationJob[] = [];
    for (const candidate of candidates) {
      input.signal?.throwIfAborted();
      const [inserted] = await tx
        .insert(paymentReconciliationJobs)
        .values({ orderId: candidate.orderId, nextAttemptAt: now })
        .onConflictDoNothing({ target: paymentReconciliationJobs.orderId })
        .returning({ id: paymentReconciliationJobs.id });
      input.signal?.throwIfAborted();
      if (!inserted) continue;
      jobs.push({
        orderId: candidate.orderId,
        environment: parseEnvironment(candidate.environment),
        externalOrderId: candidate.externalOrderId,
        model: parseModel(candidate.model),
        currency: parseCurrency(candidate.currency),
        amountMinor: candidate.amountMinor,
        fulfillmentKey: candidate.fulfillmentKey,
      });
    }
    input.signal?.throwIfAborted();

    return { scanned: candidates.length, seeded: jobs.length, jobs };
  });
}

function recoveredPaymentPayload(input: {
  readonly status: "succeeded" | "failed" | "canceled";
  readonly environment: CommerceEnvironment;
  readonly orderId: string;
  readonly externalOrderId: string;
  readonly externalPaymentId: string;
  readonly storeId: string;
  readonly currency: SupportedCurrency;
  readonly amountMinor: bigint;
  readonly occurredAt: Date;
}): string {
  return JSON.stringify({
    type: `one_time_payment_${input.status}`,
    environment: input.environment,
    merchantOrderReference: input.orderId,
    externalOrderId: input.externalOrderId,
    externalPaymentId: input.externalPaymentId,
    storeId: input.storeId,
    amount: { currency: input.currency, minor: input.amountMinor.toString() },
    occurredAt: input.occurredAt.toISOString(),
  });
}

export async function reconcileStalePayments(
  database: DatabaseClient,
  provider: PaymentProvider,
  input: {
    readonly owner: string;
    readonly expectedStoreId: string;
    readonly now?: Date;
    readonly terminalClock?: () => Date;
    readonly staleAfterMs?: number;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  },
): Promise<PaymentReconciliationResult> {
  input.signal?.throwIfAborted();
  const now = input.now ?? new Date();
  const terminalClock = input.terminalClock ?? (() => new Date());
  const terminalSignal = input.signal ? { signal: input.signal } : {};
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  await seedPaymentReconciliationJobs(database, {
    now,
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    limit,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  input.signal?.throwIfAborted();
  const claims = await claimPaymentReconciliationJobs(database, {
    owner: input.owner,
    now,
    limit,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  input.signal?.throwIfAborted();
  let scanned = 0;
  let applied = 0;
  let operatorReview = 0;
  let retried = 0;

  for (const claim of claims) {
    if (input.signal?.aborted) {
      // A terminal/retry result already counted below is durable. Stop before the next claim and
      // return that committed work; otherwise the abort still cancels the reconciliation run.
      if (applied + retried + operatorReview > 0) break;
      input.signal.throwIfAborted();
    }
    scanned += 1;
    if (!claim.leaseToken) throw new Error("payment reconciliation claim token missing");
    const leaseToken = claim.leaseToken;
    const [facts] = await database
      .select({
        orderId: orders.id,
        environment: orders.environment,
        externalOrderId: orders.externalOrderId,
        model: commerceProducts.model,
        currency: orders.expectedCurrency,
        amountMinor: orders.expectedMinor,
      })
      .from(paymentReconciliationJobs)
      .innerJoin(orders, eq(orders.id, paymentReconciliationJobs.orderId))
      .innerJoin(commerceProducts, eq(commerceProducts.id, orders.productId))
      .where(eq(paymentReconciliationJobs.id, claim.id))
      .limit(1);
    input.signal?.throwIfAborted();
    if (!facts) throw new Error("payment reconciliation order facts missing");
    const environment = parseEnvironment(facts.environment);
    const model = parseModel(facts.model);
    const currency = parseCurrency(facts.currency);
    let lookup: PaymentLookupResult;
    try {
      lookup = await awaitProviderLookup(
        () =>
          provider.getPayment({
            environment,
            merchantOrderReference: facts.orderId,
            ...(facts.externalOrderId ? { externalOrderId: facts.externalOrderId } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          }),
        input.signal,
      );
    } catch (error) {
      if (error === input.signal?.reason || isAbortError(error) || input.signal?.aborted)
        throw error;
      if (
        await retryPaymentReconciliationJob(database, {
          id: claim.id,
          owner: input.owner,
          leaseToken,
          terminalClock,
          errorCode: "PROVIDER_LOOKUP_FAILED",
          ...terminalSignal,
        })
      ) {
        retried += 1;
      }
      continue;
    }
    input.signal?.throwIfAborted();
    if (
      model === "subscription" ||
      lookup.payments.some((payment) => payment.model === "subscription")
    ) {
      if (
        await operatorReviewPaymentReconciliationJob(database, {
          id: claim.id,
          owner: input.owner,
          leaseToken,
          terminalClock,
          reason: "payment-level period unavailable",
          warnings: lookup.warnings,
          ...terminalSignal,
        })
      ) {
        operatorReview += 1;
      }
      continue;
    }
    const succeededPayments = lookup.payments.filter((payment) => payment.status === "succeeded");
    if (succeededPayments.length > 1) {
      if (
        await operatorReviewPaymentReconciliationJob(database, {
          id: claim.id,
          owner: input.owner,
          leaseToken,
          terminalClock,
          reason: "multiple succeeded provider payments returned",
          warnings: lookup.warnings,
          ...terminalSignal,
        })
      ) {
        operatorReview += 1;
      }
      continue;
    }
    if (
      succeededPayments.length === 0 &&
      (lookup.payments.length === 0 ||
        lookup.payments.some((payment) => payment.status === "pending"))
    ) {
      if (
        await retryPaymentReconciliationJob(database, {
          id: claim.id,
          owner: input.owner,
          leaseToken,
          terminalClock,
          errorCode: lookup.payments.length === 0 ? "PAYMENT_NOT_FOUND" : "PAYMENT_PENDING",
          warnings: lookup.warnings,
          ...terminalSignal,
        })
      ) {
        retried += 1;
      }
      continue;
    }
    const snapshot =
      succeededPayments[0] ??
      [...lookup.payments].sort((left, right) => {
        const timeDifference = right.occurredAt.getTime() - left.occurredAt.getTime();
        if (timeDifference !== 0) return timeDifference;
        return right.externalPaymentId.localeCompare(left.externalPaymentId);
      })[0];
    if (!snapshot) throw new Error("payment reconciliation provider result missing");
    if (snapshot.status === "pending") {
      throw new Error("pending payment escaped reconciliation retry classification");
    }
    if (
      snapshot.environment !== environment ||
      snapshot.storeId !== input.expectedStoreId ||
      snapshot.merchantOrderReference !== facts.orderId ||
      (facts.externalOrderId !== null && snapshot.externalOrderId !== facts.externalOrderId) ||
      snapshot.amount.currency !== currency ||
      snapshot.amount.minor !== facts.amountMinor
    ) {
      if (
        await operatorReviewPaymentReconciliationJob(database, {
          id: claim.id,
          owner: input.owner,
          leaseToken,
          terminalClock,
          reason: "provider payment facts mismatch",
          warnings: lookup.warnings,
          ...terminalSignal,
        })
      ) {
        operatorReview += 1;
      }
      continue;
    }

    const canonicalPayload = recoveredPaymentPayload({
      status: snapshot.status,
      environment,
      orderId: facts.orderId,
      externalOrderId: snapshot.externalOrderId,
      externalPaymentId: snapshot.externalPaymentId,
      storeId: snapshot.storeId,
      currency,
      amountMinor: facts.amountMinor,
      occurredAt: snapshot.occurredAt,
    });
    const payloadHash = createHash("sha256").update(canonicalPayload).digest("hex");
    const eventId = `payment-reconciliation:${environment}:${snapshot.externalPaymentId}:${snapshot.status}`;
    const event =
      snapshot.status === "succeeded"
        ? {
            type: "one_time_payment_succeeded" as const,
            eventId,
            environment,
            externalOrderId: snapshot.externalOrderId,
            merchantOrderReference: facts.orderId,
            externalPaymentId: snapshot.externalPaymentId,
            amount: snapshot.amount,
            occurredAt: snapshot.occurredAt,
            storeId: snapshot.storeId,
          }
        : snapshot.status === "failed"
          ? {
              type: "one_time_payment_failed" as const,
              eventId,
              environment,
              externalOrderId: snapshot.externalOrderId,
              merchantOrderReference: facts.orderId,
              externalPaymentId: snapshot.externalPaymentId,
              occurredAt: snapshot.occurredAt,
              storeId: snapshot.storeId,
            }
          : {
              type: "one_time_payment_canceled" as const,
              eventId,
              environment,
              externalOrderId: snapshot.externalOrderId,
              merchantOrderReference: facts.orderId,
              externalPaymentId: snapshot.externalPaymentId,
              occurredAt: snapshot.occurredAt,
              storeId: snapshot.storeId,
            };
    let claimOutcome: "applied" | "operator_review" | "stale";
    try {
      claimOutcome = await database.transaction(async (tx) => {
        const fence = await acquirePaymentReconciliationFence(tx, {
          id: claim.id,
          owner: input.owner,
          leaseToken,
          terminalClock,
          ...terminalSignal,
        });
        if (!fence) return "stale" as const;

        const eventOutcome = await processProviderEventInTransaction(tx, event, payloadHash);
        fence.signal?.throwIfAborted();
        if (eventOutcome === "identity_conflict") {
          const reviewed = await operatorReviewPaymentReconciliationJobInTransaction(tx, fence, {
            reason: "provider event identity conflict",
            warnings: lookup.warnings,
          });
          return reviewed ? ("operator_review" as const) : ("stale" as const);
        }
        if (eventOutcome === "operator_review") {
          const reviewed = await operatorReviewPaymentReconciliationJobInTransaction(tx, fence, {
            reason: "distinct succeeded payment already fulfilled order",
            warnings: lookup.warnings,
          });
          return reviewed ? ("operator_review" as const) : ("stale" as const);
        }
        const completed = await completePaymentReconciliationJobInTransaction(tx, fence);
        fence.signal?.throwIfAborted();
        const warnings = validateProviderQueryWarnings(lookup.warnings);
        if (completed && warnings.length > 0) {
          await tx
            .insert(commerceReconciliationRuns)
            .values({
              dedupKey: `payment-reconciliation:${claim.id}:${leaseToken}:applied-warnings`,
              targetType: "payment_reconciliation_job",
              targetId: claim.id,
              actorType: "worker",
              beforeJson: { state: "processing", orderId: facts.orderId },
              afterJson: { state: "completed", warnings },
              result: "applied_with_provider_warnings",
              createdAt: fence.terminalNow,
            })
            .onConflictDoNothing();
        }
        // Cancellation linearizes at this final in-transaction check. Once the callback returns,
        // the database commit outcome is authoritative and the caller must await and report it.
        fence.signal?.throwIfAborted();
        return completed ? ("applied" as const) : ("stale" as const);
      });
    } catch (error) {
      if (error === input.signal?.reason || isAbortError(error) || input.signal?.aborted)
        throw error;
      if (
        await operatorReviewPaymentReconciliationJob(database, {
          id: claim.id,
          owner: input.owner,
          leaseToken,
          terminalClock,
          reason: "provider event application failed",
          warnings: lookup.warnings,
          ...terminalSignal,
        })
      ) {
        operatorReview += 1;
      }
      continue;
    }
    if (claimOutcome === "applied") applied += 1;
    if (claimOutcome === "operator_review") operatorReview += 1;
  }

  return { scanned, applied, retried, operatorReview };
}
