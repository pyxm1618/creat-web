import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { DatabaseClient, DatabaseTransaction } from "@/platform/database/client";
import {
  commerceReconciliationRuns,
  fulfillmentJobs,
  paymentReconciliationJobs,
  paymentWebhookInbox,
} from "@/platform/database/commerce-schema";
import { commerceCommandJobs } from "@/platform/database/subscription-schema";

import { validateProviderQueryWarnings } from "./provider-query-warnings";

const LEASE_MS = 5 * 60 * 1000;
const PAYMENT_RECONCILIATION_MAX_ATTEMPTS = 12;

type PaymentReconciliationWarning = {
  readonly message: string;
  readonly layer: string;
  readonly aiHint?: string;
};

function allowlistedWarnings(
  warnings: readonly PaymentReconciliationWarning[] | undefined,
): readonly PaymentReconciliationWarning[] {
  return validateProviderQueryWarnings(warnings);
}

export async function claimWebhookInbox(
  database: DatabaseClient,
  input: { readonly owner: string; readonly limit?: number; readonly now?: Date },
) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  return database.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(paymentWebhookInbox)
      .where(
        and(
          inArray(paymentWebhookInbox.state, ["pending", "retry", "processing"]),
          lte(paymentWebhookInbox.nextAttemptAt, now),
          or(
            isNull(paymentWebhookInbox.leaseOwner),
            isNull(paymentWebhookInbox.leaseExpiresAt),
            lte(paymentWebhookInbox.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(paymentWebhookInbox.receivedAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    const claimed = [];
    for (const row of candidates) {
      const [updated] = await tx
        .update(paymentWebhookInbox)
        .set({ leaseOwner: input.owner, leaseExpiresAt: expiresAt, state: "processing" })
        .where(eq(paymentWebhookInbox.id, row.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function claimFulfillmentJobs(
  database: DatabaseClient,
  input: { readonly owner: string; readonly limit?: number; readonly now?: Date },
) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  return database.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(fulfillmentJobs)
      .where(
        and(
          inArray(fulfillmentJobs.state, ["pending", "processing"]),
          lte(fulfillmentJobs.nextAttemptAt, now),
          or(
            isNull(fulfillmentJobs.leaseOwner),
            isNull(fulfillmentJobs.leaseExpiresAt),
            lte(fulfillmentJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(fulfillmentJobs.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    const claimed = [];
    for (const row of candidates) {
      const [updated] = await tx
        .update(fulfillmentJobs)
        .set({ leaseOwner: input.owner, leaseExpiresAt: expiresAt, state: "processing" })
        .where(eq(fulfillmentJobs.id, row.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function claimCommerceCommandJobs(
  database: DatabaseClient,
  input: { readonly owner: string; readonly limit?: number; readonly now?: Date },
) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  return database.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(commerceCommandJobs)
      .where(
        and(
          inArray(commerceCommandJobs.state, ["pending", "processing"]),
          lte(commerceCommandJobs.nextAttemptAt, now),
          or(
            isNull(commerceCommandJobs.leaseOwner),
            isNull(commerceCommandJobs.leaseExpiresAt),
            lte(commerceCommandJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(commerceCommandJobs.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    const claimed = [];
    for (const row of candidates) {
      const [updated] = await tx
        .update(commerceCommandJobs)
        .set({ leaseOwner: input.owner, leaseExpiresAt: expiresAt, state: "processing" })
        .where(eq(commerceCommandJobs.id, row.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function claimPaymentReconciliationJobs(
  database: DatabaseClient,
  input: { readonly owner: string; readonly limit?: number; readonly now?: Date },
) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  return database.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(paymentReconciliationJobs)
      .where(
        or(
          and(
            eq(paymentReconciliationJobs.state, "pending"),
            lte(paymentReconciliationJobs.nextAttemptAt, now),
          ),
          and(
            eq(paymentReconciliationJobs.state, "processing"),
            lte(paymentReconciliationJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(
        sql`case when ${paymentReconciliationJobs.state} = 'processing' then ${paymentReconciliationJobs.leaseExpiresAt} else ${paymentReconciliationJobs.nextAttemptAt} end`,
        paymentReconciliationJobs.createdAt,
        paymentReconciliationJobs.id,
      )
      .limit(limit)
      .for("update", { skipLocked: true });

    const claimed = [];
    for (const row of candidates) {
      const [updated] = await tx
        .update(paymentReconciliationJobs)
        .set({
          state: "processing",
          leaseOwner: input.owner,
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: expiresAt,
          updatedAt: now,
        })
        .where(eq(paymentReconciliationJobs.id, row.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

type PaymentReconciliationClaim = {
  readonly id: string;
  readonly owner: string;
  readonly leaseToken: string;
};

type PaymentReconciliationTerminalInput = PaymentReconciliationClaim & {
  readonly terminalClock: () => Date;
  readonly signal?: AbortSignal;
};

const paymentReconciliationFenceBrand: unique symbol = Symbol("paymentReconciliationFence");

export type PaymentReconciliationFence = PaymentReconciliationClaim & {
  readonly [paymentReconciliationFenceBrand]: true;
  readonly terminalNow: Date;
  readonly attempts: number;
  readonly orderId: string;
  readonly signal?: AbortSignal;
};

function ownedPaymentReconciliationClaim(input: PaymentReconciliationClaim) {
  return and(
    eq(paymentReconciliationJobs.id, input.id),
    eq(paymentReconciliationJobs.state, "processing"),
    eq(paymentReconciliationJobs.leaseOwner, input.owner),
    eq(paymentReconciliationJobs.leaseToken, input.leaseToken),
  );
}

function ownedLivePaymentReconciliationFence(input: PaymentReconciliationFence) {
  return and(
    ownedPaymentReconciliationClaim(input),
    gt(paymentReconciliationJobs.leaseExpiresAt, input.terminalNow),
  );
}

export async function acquirePaymentReconciliationFence(
  tx: DatabaseTransaction,
  input: PaymentReconciliationTerminalInput,
): Promise<PaymentReconciliationFence | null> {
  const [owned] = await tx
    .select({
      attempts: paymentReconciliationJobs.attempts,
      orderId: paymentReconciliationJobs.orderId,
      leaseExpiresAt: paymentReconciliationJobs.leaseExpiresAt,
    })
    .from(paymentReconciliationJobs)
    .where(ownedPaymentReconciliationClaim(input))
    .for("update");
  if (!owned?.leaseExpiresAt) return null;
  input.signal?.throwIfAborted();
  const terminalNow = input.terminalClock();
  input.signal?.throwIfAborted();
  if (!Number.isFinite(terminalNow.getTime())) {
    throw new Error("payment reconciliation terminal clock returned an invalid date");
  }
  if (owned.leaseExpiresAt <= terminalNow) return null;
  return {
    [paymentReconciliationFenceBrand]: true,
    id: input.id,
    owner: input.owner,
    leaseToken: input.leaseToken,
    terminalNow,
    attempts: owned.attempts,
    orderId: owned.orderId,
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

export async function completePaymentReconciliationJobInTransaction(
  tx: DatabaseTransaction,
  fence: PaymentReconciliationFence,
): Promise<boolean> {
  const [completed] = await tx
    .update(paymentReconciliationJobs)
    .set({
      state: "completed",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      completedAt: fence.terminalNow,
      updatedAt: fence.terminalNow,
    })
    .where(ownedLivePaymentReconciliationFence(fence))
    .returning({ id: paymentReconciliationJobs.id });
  fence.signal?.throwIfAborted();
  return completed !== undefined;
}

export async function completePaymentReconciliationJob(
  database: DatabaseClient,
  input: PaymentReconciliationTerminalInput,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const fence = await acquirePaymentReconciliationFence(tx, input);
    if (!fence) return false;
    return completePaymentReconciliationJobInTransaction(tx, fence);
  });
}

async function retryPaymentReconciliationJobInTransaction(
  tx: DatabaseTransaction,
  fence: PaymentReconciliationFence,
  input: {
    readonly errorCode: string;
    readonly warnings?: readonly PaymentReconciliationWarning[];
  },
): Promise<boolean> {
  const attempts = fence.attempts + 1;
  const dead = attempts >= PAYMENT_RECONCILIATION_MAX_ATTEMPTS;
  const errorCode = input.errorCode.slice(0, 120);
  const warnings = allowlistedWarnings(input.warnings);
  const [retried] = await tx
    .update(paymentReconciliationJobs)
    .set({
      state: dead ? "dead_letter" : "pending",
      attempts,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: dead
        ? fence.terminalNow
        : new Date(fence.terminalNow.getTime() + retryDelay(attempts)),
      lastErrorCode: errorCode,
      completedAt: dead ? fence.terminalNow : null,
      updatedAt: fence.terminalNow,
    })
    .where(ownedLivePaymentReconciliationFence(fence))
    .returning({ id: paymentReconciliationJobs.id });
  if (!retried) return false;
  fence.signal?.throwIfAborted();

  await tx
    .insert(commerceReconciliationRuns)
    .values({
      dedupKey: `payment-reconciliation:${fence.id}:${fence.leaseToken}:retry`,
      targetType: "payment_reconciliation_job",
      targetId: fence.id,
      actorType: "worker",
      beforeJson: {
        state: "processing",
        orderId: fence.orderId,
        attempts: fence.attempts,
      },
      afterJson: {
        state: dead ? "dead_letter" : "pending",
        errorCode,
        warnings,
      },
      result: dead ? "quarantined" : "retry_scheduled",
      createdAt: fence.terminalNow,
    })
    .onConflictDoNothing();
  fence.signal?.throwIfAborted();
  return true;
}

export async function retryPaymentReconciliationJob(
  database: DatabaseClient,
  input: PaymentReconciliationTerminalInput & {
    readonly errorCode: string;
    readonly warnings?: readonly PaymentReconciliationWarning[];
  },
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const fence = await acquirePaymentReconciliationFence(tx, input);
    if (!fence) return false;
    return retryPaymentReconciliationJobInTransaction(tx, fence, input);
  });
}

type PaymentReconciliationOperatorReviewInput = PaymentReconciliationTerminalInput & {
  readonly reason: string;
  readonly warnings?: readonly PaymentReconciliationWarning[];
};

export async function operatorReviewPaymentReconciliationJobInTransaction(
  tx: DatabaseTransaction,
  fence: PaymentReconciliationFence,
  input: Pick<PaymentReconciliationOperatorReviewInput, "reason" | "warnings">,
): Promise<boolean> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("payment reconciliation operator-review reason is required");

  const [reviewed] = await tx
    .update(paymentReconciliationJobs)
    .set({
      state: "operator_review",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      operatorReviewReason: reason,
      completedAt: fence.terminalNow,
      updatedAt: fence.terminalNow,
    })
    .where(ownedLivePaymentReconciliationFence(fence))
    .returning({ id: paymentReconciliationJobs.id });
  if (!reviewed) return false;
  fence.signal?.throwIfAborted();

  await tx
    .insert(commerceReconciliationRuns)
    .values({
      dedupKey: `payment-reconciliation:${fence.id}:${fence.leaseToken}:operator-review`,
      targetType: "payment_reconciliation_job",
      targetId: fence.id,
      actorType: "worker",
      beforeJson: {
        state: "processing",
        orderId: fence.orderId,
        attempts: fence.attempts,
      },
      afterJson: {
        state: "operator_review",
        reason,
        warnings: allowlistedWarnings(input.warnings),
      },
      result: "operator_review_required",
      createdAt: fence.terminalNow,
    })
    .onConflictDoNothing();
  fence.signal?.throwIfAborted();
  return true;
}

export async function operatorReviewPaymentReconciliationJob(
  database: DatabaseClient,
  input: PaymentReconciliationOperatorReviewInput,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const fence = await acquirePaymentReconciliationFence(tx, input);
    if (!fence) return false;
    return operatorReviewPaymentReconciliationJobInTransaction(tx, fence, input);
  });
}

export function retryDelay(attempt: number): number {
  return Math.min(60 * 60 * 1000, 2 ** Math.min(attempt, 10) * 1000);
}
