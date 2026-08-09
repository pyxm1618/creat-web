import type { PaymentProvider } from "@/platform/commerce/application/payment-provider";
import type { DatabaseClient } from "@/platform/database/client";

import type { OrderFulfillment } from "./order-fulfillment";
import { runFulfillmentWorker } from "./run-fulfillment-worker";
import { runWebhookInboxWorker } from "./run-webhook-inbox-worker";
import { runCommerceCommandWorker } from "./run-commerce-command-worker";

export async function runCommerceWorker(input: {
  readonly database: DatabaseClient;
  readonly provider: PaymentProvider;
  readonly fulfillment: OrderFulfillment;
  readonly owner: string;
  readonly now?: Date;
  readonly limit?: number;
  readonly onClaimed?: (count: number) => void;
}): Promise<{
  readonly inboxProcessed: number;
  readonly commandProcessed: number;
  readonly fulfillmentProcessed: number;
}> {
  const now = input.now ?? new Date();
  const batchLimit = Math.min(Math.max(input.limit ?? 60, 1), 100);
  let remaining = batchLimit;
  const inbox = await runWebhookInboxWorker({
    database: input.database,
    owner: input.owner,
    now,
    limit: remaining,
  });
  remaining -= inbox.claimed;

  let commandClaimed = 0;
  const commandProcessed =
    remaining > 0
      ? await runCommerceCommandWorker({
          database: input.database,
          provider: input.provider,
          owner: input.owner,
          now,
          limit: remaining,
          onClaimed: (count) => {
            commandClaimed = count;
          },
        })
      : 0;
  remaining -= commandClaimed;

  const fulfillment =
    remaining > 0
      ? await runFulfillmentWorker({
          database: input.database,
          fulfillment: input.fulfillment,
          owner: input.owner,
          now,
          limit: remaining,
        })
      : { claimed: 0, processed: 0 };
  remaining -= fulfillment.claimed;

  input.onClaimed?.(batchLimit - remaining);
  return {
    inboxProcessed: inbox.processed,
    commandProcessed,
    fulfillmentProcessed: fulfillment.processed,
  };
}
