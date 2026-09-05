import { readFile } from "node:fs/promises";

import { featuresConfig } from "@/config/features.config";
import { fulfillmentHandlers } from "@/config/fulfillment.config";
import { productDefinitions } from "@/config/products.config";
import { createProductCatalog } from "@/platform/commerce/application/product-catalog";

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
};
if (packageJson.dependencies?.["@waffo/pancake-ts"] !== "0.18.0") {
  throw new Error("Waffo Pancake SDK must be exactly pinned to 0.18.0");
}

const catalog = createProductCatalog(productDefinitions);
const enabledProducts = catalog.definitions.filter((product) => product.enabled);

if (featuresConfig.commerce.enabled) {
  if (enabledProducts.length === 0)
    throw new Error("enabled commerce requires at least one enabled product");

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

const contract = await readFile("docs/参考/waffo-合约与验收.md", "utf8");
if (!contract.includes("真实商户资源验证仍未完成")) {
  throw new Error("Waffo contract document must state the live-resource gate");
}
if (contract.includes("WAFFO_CONTRACT_VERIFIED=1") === false) {
  throw new Error("Waffo contract document must describe the deployment gate");
}
const paymentGateHeading = "## 支付查询的强制激活门禁";
const paymentGate = contract.slice(contract.indexOf(paymentGateHeading));
if (!paymentGate.startsWith(paymentGateHeading)) {
  throw new Error("Waffo contract document must define the live payment-query gate");
}
for (const requirement of [
  "已认证的商户 GraphQL 内省",
  "`String!` 变量",
  "完全相同的过滤条件",
  "没有截断、数量不符或重复 ID",
  "`testMode`、店铺、金额、币种和 `createdAt`",
  "有代表性的一次性支付快照",
  "支付级不可变订阅周期",
  "订阅自动恢复保持 NO-GO",
  "在原始资源清单和这份支付查询门禁都通过之前，不得设置",
]) {
  if (!paymentGate.includes(requirement)) {
    throw new Error(`Waffo payment-query activation gate is incomplete: ${requirement}`);
  }
}

console.log(
  JSON.stringify({
    event: "commerce_verified",
    commerceEnabled: featuresConfig.commerce.enabled,
    enabledProducts: enabledProducts.length,
    sdkVersion: packageJson.dependencies?.["@waffo/pancake-ts"],
  }),
);
