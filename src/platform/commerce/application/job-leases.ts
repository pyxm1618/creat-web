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
  readonly terminalNow: Date;
};

function ownedLivePaymentReconciliationClaim(input: PaymentReconciliationClaim) {
  return and(
    eq(paymentReconciliationJobs.id, input.id),
    eq(paymentReconciliationJobs.state, "processing"),
    eq(paymentReconciliationJobs.leaseOwner, input.owner),
    eq(paymentReconciliationJobs.leaseToken, input.leaseToken),
    gt(paymentReconciliationJobs.leaseExpiresAt, input.terminalNow),
  );
}

export async function completePaymentReconciliationJob(
  database: DatabaseClient | DatabaseTransaction,
  input: PaymentReconciliationClaim,
): Promise<boolean> {
  const [completed] = await database
    .update(paymentReconciliationJobs)
    .set({
      state: "completed",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      completedAt: input.terminalNow,
      updatedAt: input.terminalNow,
    })
    .where(ownedLivePaymentReconciliationClaim(input))
    .returning({ id: paymentReconciliationJobs.id });
  return completed !== undefined;
}

export async function retryPaymentReconciliationJob(
  database: DatabaseClient,
  input: PaymentReconciliationClaim & {
    readonly errorCode: string;
    readonly warnings?: readonly PaymentReconciliationWarning[];
  },
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [owned] = await tx
      .select({
        attempts: paymentReconciliationJobs.attempts,
        orderId: paymentReconciliationJobs.orderId,
      })
      .from(paymentReconciliationJobs)
      .where(ownedLivePaymentReconciliationClaim(input))
      .for("update");
    if (!owned) return false;

    const attempts = owned.attempts + 1;
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
          ? input.terminalNow
          : new Date(input.terminalNow.getTime() + retryDelay(attempts)),
        lastErrorCode: errorCode,
        completedAt: dead ? input.terminalNow : null,
        updatedAt: input.terminalNow,
      })
      .where(ownedLivePaymentReconciliationClaim(input))
      .returning({ id: paymentReconciliationJobs.id });
    if (!retried) return false;

    await tx
      .insert(commerceReconciliationRuns)
      .values({
        dedupKey: `payment-reconciliation:${input.id}:${input.leaseToken}:retry`,
        targetType: "payment_reconciliation_job",
        targetId: input.id,
        actorType: "worker",
        beforeJson: {
          state: "processing",
          orderId: owned.orderId,
          attempts: owned.attempts,
        },
        afterJson: {
          state: dead ? "dead_letter" : "pending",
          errorCode,
          warnings,
        },
        result: dead ? "quarantined" : "retry_scheduled",
        createdAt: input.terminalNow,
      })
      .onConflictDoNothing();
    return true;
  });
}

type PaymentReconciliationOperatorReviewInput = PaymentReconciliationClaim & {
  readonly reason: string;
  readonly warnings?: readonly PaymentReconciliationWarning[];
};

export async function operatorReviewPaymentReconciliationJobInTransaction(
  tx: DatabaseTransaction,
  input: PaymentReconciliationOperatorReviewInput,
): Promise<boolean> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("payment reconciliation operator-review reason is required");

  const [owned] = await tx
    .select({
      attempts: paymentReconciliationJobs.attempts,
      orderId: paymentReconciliationJobs.orderId,
    })
    .from(paymentReconciliationJobs)
    .where(ownedLivePaymentReconciliationClaim(input))
    .for("update");
  if (!owned) return false;

  const [reviewed] = await tx
    .update(paymentReconciliationJobs)
    .set({
      state: "operator_review",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      operatorReviewReason: reason,
      completedAt: input.terminalNow,
      updatedAt: input.terminalNow,
    })
    .where(ownedLivePaymentReconciliationClaim(input))
    .returning({ id: paymentReconciliationJobs.id });
  if (!reviewed) return false;

  await tx
    .insert(commerceReconciliationRuns)
    .values({
      dedupKey: `payment-reconciliation:${input.id}:${input.leaseToken}:operator-review`,
      targetType: "payment_reconciliation_job",
      targetId: input.id,
      actorType: "worker",
      beforeJson: {
        state: "processing",
        orderId: owned.orderId,
        attempts: owned.attempts,
      },
      afterJson: {
        state: "operator_review",
        reason,
        warnings: allowlistedWarnings(input.warnings),
      },
      result: "operator_review_required",
      createdAt: input.terminalNow,
    })
    .onConflictDoNothing();
  return true;
}

export async function operatorReviewPaymentReconciliationJob(
  database: DatabaseClient,
  input: PaymentReconciliationOperatorReviewInput,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    return operatorReviewPaymentReconciliationJobInTransaction(tx, input);
  });
}

export function retryDelay(attempt: number): number {
  return Math.min(60 * 60 * 1000, 2 ** Math.min(attempt, 10) * 1000);
}
