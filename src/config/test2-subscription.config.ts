import type { CreditOrderFulfillmentDefinition } from "@/platform/credits/integration/commerce/credit-fulfillment";
import type { ProductDefinition } from "@/platform/commerce/domain/product";

export const test2ProductDefinition = {
  key: "test2",
  version: 1,
  enabled: true,
  commercialModel: "subscription",
  billingInterval: "month",
  currency: "USD",
  expectedPrice: "1.88",
  providerProductIdByEnvironment: { test: "PROD_3caeAywntktbBjnkRonFVn" },
  fulfillmentKey: "test2-usage-credits",
  refundPolicyKey: "default-subscription",
} as const satisfies ProductDefinition;

export const test2UsageCredits = {
  fulfillmentKey: "test2-usage-credits",
  creditType: "usage",
  quantity: 100,
} as const satisfies CreditOrderFulfillmentDefinition;
