import { expect, it } from "vitest";

import { test2ProductDefinition, test2UsageCredits } from "@/config/test2-subscription.config";
import { featuresConfig } from "@/config/features.config";
import { homeConfig } from "@/config/home.config";
import { productSnapshot } from "@/platform/commerce/domain/product";

it("defines the approved Waffo Test monthly subscription and usage credits", () => {
  expect(productSnapshot(test2ProductDefinition, "test")).toMatchObject({
    commercialModel: "subscription",
    billingInterval: "month",
    expected: { currency: "USD", minor: 188n },
    providerProductId: "PROD_3caeAywntktbBjnkRonFVn",
    fulfillmentKey: "test2-usage-credits",
  });

  expect(test2UsageCredits).toEqual({
    fulfillmentKey: "test2-usage-credits",
    creditType: "usage",
    quantity: 100,
  });
});

it("gates the test2 subscription offer by the subscription feature", () => {
  const pricing = homeConfig.sections.find((section) => section.type === "pricing");
  expect(pricing?.enabled).toBe(featuresConfig.commerce.subscriptions);
  expect(pricing?.type).toBe("pricing");
  if (pricing?.type !== "pricing") throw new Error("subscription pricing section is missing");
  expect(pricing.cards).toHaveLength(1);
});
