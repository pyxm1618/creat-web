import { and, eq } from "drizzle-orm";

import type { PaymentProvider } from "./payment-provider";
import type { DatabaseClient } from "@/platform/database/client";
import { payments, refunds } from "@/platform/database/schema";
import type { CommerceCommandJob } from "./execute-commerce-command";

export async function executeRefundRequest(input: {
  readonly database: DatabaseClient;
  readonly provider: PaymentProvider;
  readonly job: CommerceCommandJob;
  readonly now: Date;
}): Promise<void> {
  const rows = await input.database
    .select({ refund: refunds, externalPaymentId: payments.externalPaymentId })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(eq(refunds.id, input.job.targetId))
    .limit(1);
  const row = rows[0];
  if (!row || row.refund.subjectId !== input.job.subjectId)
    throw new Error("refund command target not found");
  if (row.refund.status !== "pending" && row.refund.status !== "processing") return;
  const expectedStatus = row.refund.status;

  const result = await input.provider.requestRefund({
    environment: row.refund.environment === "production" ? "production" : "test",
    buyerIdentity: input.job.subjectId,
    externalPaymentId: row.externalPaymentId,
    amount: {
      currency: row.refund.currency as
        | "USD"
        | "EUR"
        | "GBP"
        | "SGD"
        | "AUD"
        | "CAD"
        | "JPY"
        | "KRW",
      minor: row.refund.requestedMinor,
    },
    reason: row.refund.reason,
    idempotencyKey: row.refund.idempotencyKey,
  });
  const failed = result.status === "failed";
  await input.database
    .update(refunds)
    .set({
      externalRefundReference: result.externalRefundReference,
      status: failed ? "failed" : result.status === "succeeded" ? "processing" : result.status,
      ...(failed ? { reversalStatus: "not_required", operatorReviewReason: null } : {}),
      providerUpdatedAt: input.now,
      updatedAt: input.now,
    })
    .where(and(eq(refunds.id, row.refund.id), eq(refunds.status, expectedStatus)));
}
