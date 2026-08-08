import type { FulfillmentHandler } from "@/platform/commerce/application/order-fulfillment";
import {
  createCreditOrderFulfillment,
  type CreditOrderFulfillmentDefinition,
} from "@/platform/commerce/fulfillment/credit-order-fulfillment";
import type { DatabaseClient } from "@/platform/database/client";

export function createCreditFulfillmentHandlers(
  database: DatabaseClient,
  definitions: readonly CreditOrderFulfillmentDefinition[],
): Readonly<Record<string, FulfillmentHandler>> {
  const handlers: Record<string, FulfillmentHandler> = {};
  for (const definition of definitions) {
    if (!Number.isSafeInteger(definition.quantity) || definition.quantity <= 0) {
      throw new Error("credit fulfillment quantity must be a positive safe integer");
    }
    if (!definition.fulfillmentKey.trim() || !definition.creditType.trim()) {
      throw new Error("credit fulfillment key and type are required");
    }
    const operation = `fulfill:${definition.fulfillmentKey}`;
    if (handlers[operation]) throw new Error(`duplicate credit fulfillment operation: ${operation}`);
    handlers[operation] = createCreditOrderFulfillment(database, definition);
  }
  return handlers;
}
