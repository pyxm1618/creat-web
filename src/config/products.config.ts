import { createProductCatalog } from "@/platform/commerce/application/product-catalog";
import { featuresConfig } from "@/config/features.config";
import type { ProductDefinition } from "@/platform/commerce/domain/product";
import { test2ProductDefinition } from "./test2-subscription.config";

export const productDefinitions = [
  {
    ...test2ProductDefinition,
    enabled: featuresConfig.commerce.subscriptions,
  },
] as const satisfies readonly ProductDefinition[];

export const productCatalog = createProductCatalog(productDefinitions);
