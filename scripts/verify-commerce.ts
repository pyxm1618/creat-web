import { readFile } from "node:fs/promises";

import { featuresConfig } from "@/config/features.config";
import { fulfillmentHandlers } from "@/config/fulfillment.config";
import { productDefinitions } from "@/config/products.config";
import { createProductCatalog } from "@/platform/commerce/application/product-catalog";

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
};
if (packageJson.dependencies?.["@waffo/pancake-ts"] !== "0.16.0") {
  throw new Error("Waffo Pancake SDK must be exactly pinned to 0.16.0");
}

const catalog = createProductCatalog(productDefinitions);
const enabledProducts = catalog.definitions.filter((product) => product.enabled);

if (featuresConfig.commerce.enabled) {
  if (enabledProducts.length === 0) throw new Error("enabled commerce requires at least one enabled product");

  for (const product of enabledProducts) {
    catalog.getEnabled(product.key, "production");
    const operation = `fulfill:${product.fulfillmentKey}`;
    if (!(operation in fulfillmentHandlers)) {
      throw new Error(`missing production fulfillment handler: ${operation}`);
    }
  }
}

if (!featuresConfig.commerce.enabled && enabledProducts.length > 0) {
  throw new Error("disabled commerce must not ship enabled products");
}

const contract = await readFile("docs/providers/waffo-contract-2026-08-08.md", "utf8");
if (!contract.includes("live merchant resource validation still required")) {
  throw new Error("Waffo contract document must state the live-resource gate");
}
if (contract.includes("WAFFO_CONTRACT_VERIFIED=1") === false) {
  throw new Error("Waffo contract document must describe the deployment gate");
}

console.log(
  JSON.stringify({
    event: "commerce_verified",
    commerceEnabled: featuresConfig.commerce.enabled,
    enabledProducts: enabledProducts.length,
    sdkVersion: packageJson.dependencies?.["@waffo/pancake-ts"],
  }),
);
