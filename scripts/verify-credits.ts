import { readFile } from "node:fs/promises";

import { creditFulfillmentDefinitions } from "@/config/credits.config";
import { featuresConfig } from "@/config/features.config";
import { productDefinitions } from "@/config/products.config";

const schema = await readFile("src/platform/database/credit-schema.ts", "utf8");
if (/\bbalance\s*:/i.test(schema) || /["']balance["']\s*\)/i.test(schema)) {
  throw new Error("credit schema must not contain a mutable balance column");
}
for (const required of [
  "credit_grants",
  "credit_ledger_entries",
  "credit_reservations",
  "credit_reservation_allocations",
  "credit_finalization_jobs",
]) {
  if (!schema.includes(required)) throw new Error(`missing credit persistence table: ${required}`);
}

const operations = new Set<string>();
for (const definition of creditFulfillmentDefinitions) {
  if (!Number.isSafeInteger(definition.quantity) || definition.quantity <= 0) {
    throw new Error("credit fulfillment quantity must be a positive safe integer");
  }
  const operation = `fulfill:${definition.fulfillmentKey}`;
  if (operations.has(operation))
    throw new Error(`duplicate credit fulfillment operation: ${operation}`);
  operations.add(operation);
}

if (featuresConfig.commerce.credits) {
  if (!featuresConfig.commerce.enabled) throw new Error("credits require commerce to be enabled");
  if (creditFulfillmentDefinitions.length === 0) {
    throw new Error("enabled credits require at least one explicit credit fulfillment definition");
  }
  const enabledOneTime = productDefinitions.filter(
    (product) => product.enabled && product.commercialModel === "one_time",
  );
  for (const definition of creditFulfillmentDefinitions) {
    if (!enabledOneTime.some((product) => product.fulfillmentKey === definition.fulfillmentKey)) {
      throw new Error(
        `credit fulfillment has no enabled one-time product: ${definition.fulfillmentKey}`,
      );
    }
  }
}

const vercel = JSON.parse(await readFile("vercel.json", "utf8")) as {
  crons?: Array<{ path?: string }>;
};
if (
  featuresConfig.commerce.credits &&
  !vercel.crons?.some((cron) => cron.path === "/api/cron/credits")
) {
  throw new Error("credit recovery cron is required when credits are enabled");
}

console.log(
  JSON.stringify({
    event: "credits_verified",
    creditsEnabled: featuresConfig.commerce.credits,
    configuredFulfillments: creditFulfillmentDefinitions.length,
  }),
);
