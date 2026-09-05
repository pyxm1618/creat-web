import type { CreditOrderFulfillmentDefinition } from "@/platform/credits/integration/commerce/credit-fulfillment";
import { featuresConfig } from "@/config/features.config";

const test2UsageCredits = {
  fulfillmentKey: "test2-usage-credits",
  creditType: "usage",
  quantity: 100,
} as const satisfies CreditOrderFulfillmentDefinition;

export { test2UsageCredits };

export const creditFulfillmentDefinitions: readonly CreditOrderFulfillmentDefinition[] =
  featuresConfig.commerce.credits ? [test2UsageCredits] : [];
