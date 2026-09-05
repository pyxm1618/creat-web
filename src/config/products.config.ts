import { createProductCatalog } from "@/platform/commerce/application/product-catalog";
import { featuresConfig } from "@/config/features.config";
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

export const productDefinitions = [
  {
    ...test2ProductDefinition,
    enabled: featuresConfig.commerce.subscriptions,
  },
] as const satisfies readonly ProductDefinition[];

export const productCatalog = createProductCatalog(productDefinitions);
