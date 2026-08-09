import { and, eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { commerceProducts } from "@/platform/database/commerce-schema";

import type { CommerceEnvironment, ProductSnapshot } from "../domain/product";

export async function ensureCommerceProduct(
  database: DatabaseClient,
  snapshot: ProductSnapshot,
  environment: CommerceEnvironment,
): Promise<{ readonly id: string }> {
  const existing = await database.query.commerceProducts.findFirst({
    where: and(
      eq(commerceProducts.key, snapshot.key),
      eq(commerceProducts.version, snapshot.version),
      eq(commerceProducts.environment, environment),
    ),
  });

  if (existing) {
    const immutableMatches =
      existing.providerProductId === snapshot.providerProductId &&
      existing.currency === snapshot.expected.currency &&
      existing.expectedMinor === snapshot.expected.minor &&
      existing.model === snapshot.commercialModel &&
      existing.billingInterval === snapshot.billingInterval &&
      existing.fulfillmentKey === snapshot.fulfillmentKey &&
      existing.refundPolicyKey === snapshot.refundPolicyKey;
    if (!immutableMatches) throw new Error("product version drift detected");
    return { id: existing.id };
  }

  const [inserted] = await database
    .insert(commerceProducts)
    .values({
      key: snapshot.key,
      version: snapshot.version,
      model: snapshot.commercialModel,
      billingInterval: snapshot.billingInterval,
      environment,
      providerProductId: snapshot.providerProductId,
      currency: snapshot.expected.currency,
      expectedMinor: snapshot.expected.minor,
      fulfillmentKey: snapshot.fulfillmentKey,
      refundPolicyKey: snapshot.refundPolicyKey,
      enabled: true,
    })
    .returning({ id: commerceProducts.id });
  if (!inserted) throw new Error("commerce product insert failed");
  return inserted;
}
