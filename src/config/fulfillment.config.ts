import {
  RegistryOrderFulfillment,
  type FulfillmentHandler,
} from "@/platform/commerce/application/order-fulfillment";

export const fulfillmentHandlers = {} as const satisfies Readonly<
  Record<string, FulfillmentHandler>
>;

export function createConfiguredOrderFulfillment(
  extensions: Readonly<Record<string, FulfillmentHandler>> = {},
) {
  return new RegistryOrderFulfillment({ ...fulfillmentHandlers, ...extensions });
}
