import { and, eq, inArray, lte } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { commerceReconciliationRuns } from "@/platform/database/commerce-schema";
import { refunds } from "@/platform/database/subscription-schema";

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function reconcileStaleRefunds(
  database: DatabaseClient,
  input: { readonly now?: Date; readonly staleAfterMs?: number; readonly limit?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error("stale refund threshold must be positive");
  }
  const cutoff = new Date(now.getTime() - staleAfterMs);

  return database.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(refunds)
      .where(
        and(inArray(refunds.status, ["pending", "processing"]), lte(refunds.updatedAt, cutoff)),
      )
      .orderBy(refunds.updatedAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    let reconciled = 0;
    for (const refund of candidates) {
      const entitlementUncertain =
        refund.status === "processing" ||
        refund.externalRefundReference !== null ||
        refund.providerUpdatedAt !== null;
      const reversalStatus =
        entitlementUncertain && refund.reversalStatus === "pending"
          ? "reconciliation_required"
          : refund.reversalStatus;
      const [updated] = await tx
        .update(refunds)
        .set({
          status: "reconciliation_required",
          reversalStatus,
          operatorReviewReason:
            "provider refund settlement webhook did not arrive within threshold",
          updatedAt: now,
        })
        .where(and(eq(refunds.id, refund.id), inArray(refunds.status, ["pending", "processing"])))
        .returning({ id: refunds.id });
      if (!updated) continue;

      await tx.insert(commerceReconciliationRuns).values({
        targetType: "payment_refund",
        targetId: refund.paymentId,
        actorType: "worker",
        beforeJson: {
          refundId: refund.id,
          status: refund.status,
          externalRefundReference: refund.externalRefundReference,
          providerUpdatedAt: refund.providerUpdatedAt?.toISOString() ?? null,
        },
        afterJson: {
          refundId: refund.id,
          status: "reconciliation_required",
          reason: "provider_settlement_timeout",
          cutoff: cutoff.toISOString(),
        },
        result: "operator_review_required",
      });
      reconciled += 1;
    }
    return reconciled;
  });
}
