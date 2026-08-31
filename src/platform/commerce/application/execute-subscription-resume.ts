import { eq } from "drizzle-orm";

import { lockAccountSubject } from "@/platform/accounts/account-subject-commerce-fence";
import type { PaymentProvider } from "./payment-provider";
import type { DatabaseClient } from "@/platform/database/client";
import { subscriptions } from "@/platform/database/schema";
import type { CommerceCommandJob } from "./execute-commerce-command";

export async function executeSubscriptionResume(input: {
  readonly database: DatabaseClient;
  readonly provider: PaymentProvider;
  readonly job: CommerceCommandJob;
}): Promise<void> {
  const subscription = await input.database.transaction(async (transaction) => {
    const subject = await lockAccountSubject(transaction, input.job.subjectId);
    if (subject.status !== "active") return null;
    const [row] = await transaction
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.job.targetId))
      .limit(1)
      .for("update");
    if (!row || row.subjectId !== input.job.subjectId) {
      throw new Error("subscription command target not found");
    }
    return row;
  });
  if (!subscription) return;
  await input.provider.resumeSubscription({
    environment: subscription.environment === "production" ? "production" : "test",
    buyerIdentity: input.job.subjectId,
    externalOrderId: subscription.externalOrderId,
  });
}
