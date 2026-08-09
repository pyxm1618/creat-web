import { createProductCatalog } from "@/platform/commerce/application/product-catalog";
import type { ProductDefinition } from "@/platform/commerce/domain/product";

export const productDefinitions = [
  {
    key: "focus-credit-pack",
    version: 1,
    enabled: true,
    commercialModel: "one_time",
    currency: "USD",
    expectedPrice: "5.00",
    providerProductIdByEnvironment: { test: "test-only-focus-credit-pack" },
    fulfillmentKey: "credits:focus:10",
    refundPolicyKey: "standard-digital-test-only",
  },
  {
    key: "focus-monthly",
    version: 1,
    enabled: true,
    commercialModel: "subscription",
    billingInterval: "month",
    currency: "USD",
    expectedPrice: "9.00",
    providerProductIdByEnvironment: { test: "test-only-focus-monthly" },
    fulfillmentKey: "credits:focus:30",
    refundPolicyKey: "standard-subscription-test-only",
  },
] as const satisfies readonly ProductDefinition[];

export const productCatalog = createProductCatalog(productDefinitions);
