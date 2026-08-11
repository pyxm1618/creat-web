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
  const inboxReserved = batchLimit >= 3 ? Math.floor(batchLimit / 3) : 1;
  const commandReserved = batchLimit >= 3 ? Math.floor(batchLimit / 3) : batchLimit - 1;
  const fulfillmentReserved = batchLimit - inboxReserved - commandReserved;
  const inbox = await runWebhookInboxWorker({
    database: input.database,
    owner: input.owner,
    now,
    limit: inboxReserved,
  });

  const commandLimit = commandReserved + (inboxReserved - inbox.claimed);
  let commandClaimed = 0;
  const commandProcessed =
    commandLimit > 0
      ? await runCommerceCommandWorker({
          database: input.database,
          provider: input.provider,
          owner: input.owner,
          now,
          limit: commandLimit,
          onClaimed: (count) => {
            commandClaimed = count;
          },
        })
      : 0;

  const fulfillmentLimit = fulfillmentReserved + (commandLimit - commandClaimed);
  const fulfillment =
    fulfillmentLimit > 0
      ? await runFulfillmentWorker({
          database: input.database,
          fulfillment: input.fulfillment,
          owner: input.owner,
          now,
          limit: fulfillmentLimit,
        })
      : { claimed: 0, processed: 0 };

  input.onClaimed?.(inbox.claimed + commandClaimed + fulfillment.claimed);
  return {
    inboxProcessed: inbox.processed,
    commandProcessed,
    fulfillmentProcessed: fulfillment.processed,
  };
}
