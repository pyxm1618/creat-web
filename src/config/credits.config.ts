import type { CreditOrderFulfillmentDefinition } from "@/platform/credits/integration/commerce/credit-fulfillment";
import { featuresConfig } from "@/config/features.config";
import { test2UsageCredits } from "./test2-subscription.config";

export { test2UsageCredits };

export const creditFulfillmentDefinitions: readonly CreditOrderFulfillmentDefinition[] =
  featuresConfig.commerce.credits ? [test2UsageCredits] : [];
