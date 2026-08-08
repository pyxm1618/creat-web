import { createProductCatalog } from "@/platform/commerce/application/product-catalog";
import type { ProductDefinition } from "@/platform/commerce/domain/product";

export const productDefinitions = [] as const satisfies readonly ProductDefinition[];

export const productCatalog = createProductCatalog(productDefinitions);
