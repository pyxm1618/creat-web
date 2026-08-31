import type { PaymentProvider } from "./payment-provider";
import type { DatabaseClient } from "@/platform/database/client";
import { commerceCommandJobs } from "@/platform/database/schema";

import { executeRefundRequest } from "./execute-refund-request";
import { executeSubscriptionCancel } from "./execute-subscription-cancel";
import { executeSubscriptionResume } from "./execute-subscription-resume";

export type CommerceCommandJob = typeof commerceCommandJobs.$inferSelect;

export async function executeCommerceCommand(input: {
  readonly database: DatabaseClient;
  readonly provider: PaymentProvider;
  readonly job: CommerceCommandJob;
  readonly now: Date;
}): Promise<void> {
  if (input.job.commandType === "subscription_cancel") {
    await executeSubscriptionCancel(input);
  } else if (input.job.commandType === "subscription_resume") {
    await executeSubscriptionResume(input);
  } else if (input.job.commandType === "refund_request") {
    await executeRefundRequest(input);
  } else {
    throw new Error(`unsupported commerce command: ${input.job.commandType}`);
  }
}
