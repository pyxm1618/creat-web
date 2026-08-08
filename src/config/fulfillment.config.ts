import "server-only";

import {
  RegistryOrderFulfillment,
  type FulfillmentHandler,
} from "@/platform/commerce/application/order-fulfillment";

export const fulfillmentHandlers = {} as const satisfies Readonly<Record<string, FulfillmentHandler>>;

export function createConfiguredOrderFulfillment() {
  return new RegistryOrderFulfillment(fulfillmentHandlers);
}
