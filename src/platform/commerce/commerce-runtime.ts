import "server-only";

import { creditFulfillmentDefinitions } from "@/config/credits.config";
import { featuresConfig } from "@/config/features.config";
import { createConfiguredOrderFulfillment } from "@/config/fulfillment.config";
import { productCatalog } from "@/config/products.config";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";

import type { CommerceEnvironment } from "./domain/product";

export function commerceEnvironment(): CommerceEnvironment {
  return env.appEnv === "production" ? "production" : "test";
}

export async function getCommerceRuntime() {
  if (!featuresConfig.commerce.enabled) return null;

  if (
    !env.waffoMerchantId ||
    !env.waffoPrivateKey ||
    !env.waffoStoreId ||
    !env.waffoWebhookTestPublicKey ||
    !env.commerceRetentionKey ||
    !env.commerceRetentionKeyId
  ) {
    throw new Error("commerce runtime configuration is incomplete");
  }
  if (env.appEnv === "production" && !env.waffoWebhookProdPublicKey) {
    throw new Error("production Waffo webhook public key is required");
  }

  const { createWaffoPaymentProvider } = await import("./providers/waffo/adapter");
  const provider = createWaffoPaymentProvider({
    merchantId: env.waffoMerchantId,
    privateKey: env.waffoPrivateKey,
    storeId: env.waffoStoreId,
    webhookPublicKey: {
      test: env.waffoWebhookTestPublicKey,
      ...(env.waffoWebhookProdPublicKey ? { prod: env.waffoWebhookProdPublicKey } : {}),
    },
  });

  let creditHandlers = {};
  if (featuresConfig.commerce.credits) {
    const { createCreditFulfillmentHandlers } =
      await import("@/platform/credits/application/commerce-handlers");
    creditHandlers = createCreditFulfillmentHandlers(db, creditFulfillmentDefinitions);
  }

  return {
    database: db,
    provider,
    catalog: productCatalog,
    fulfillment: createConfiguredOrderFulfillment(creditHandlers),
    environment: commerceEnvironment(),
    retention: {
      encryptionKeyBase64: env.commerceRetentionKey,
      keyId: env.commerceRetentionKeyId,
    },
  } as const;
}
