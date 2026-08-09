import { eq } from "drizzle-orm";

import type { PaymentProvider } from "./payment-provider";
import type { DatabaseClient } from "@/platform/database/client";
import { subscriptions } from "@/platform/database/schema";
import type { CommerceCommandJob } from "./execute-commerce-command";

export async function executeSubscriptionCancel(input: {
  readonly database: DatabaseClient;
  readonly provider: PaymentProvider;
  readonly job: CommerceCommandJob;
}): Promise<void> {
  const subscription = await input.database.query.subscriptions.findFirst({
    where: eq(subscriptions.id, input.job.targetId),
  });
  if (!subscription || subscription.subjectId !== input.job.subjectId)
    throw new Error("subscription command target not found");
  await input.provider.cancelSubscription({
    environment: subscription.environment === "production" ? "production" : "test",
    buyerIdentity: input.job.subjectId,
    externalOrderId: subscription.externalOrderId,
  });
}
