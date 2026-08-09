import { expect, it } from "vitest";

import { createProductCatalog } from "@/platform/commerce/application/product-catalog";
import type { ProductDefinition } from "@/platform/commerce/domain/product";

const product: ProductDefinition = {
  key: "starter-pack",
  version: 1,
  enabled: true,
  commercialModel: "one_time",
  currency: "USD",
  expectedPrice: "2.99",
  providerProductIdByEnvironment: { test: "prod_test_1", production: "prod_live_1" },
  fulfillmentKey: "starter-pack",
  refundPolicyKey: "default-one-time",
};

it("returns the highest enabled version as an immutable snapshot", () => {
  const catalog = createProductCatalog([
    product,
    {
      ...product,
      version: 2,
      expectedPrice: "3.99",
      providerProductIdByEnvironment: { test: "prod_test_2" },
    },
  ]);
  expect(catalog.getEnabled("starter-pack", "test")).toMatchObject({
    version: 2,
    billingInterval: null,
    expected: { currency: "USD", minor: 399n },
    providerProductId: "prod_test_2",
  });
});

it("requires an explicit monthly or yearly interval for subscription products", () => {
  const monthly: ProductDefinition = {
    ...product,
    key: "pro-monthly",
    commercialModel: "subscription",
    billingInterval: "month",
  };
  expect(createProductCatalog([monthly]).getEnabled("pro-monthly", "test")).toMatchObject({
    commercialModel: "subscription",
    billingInterval: "month",
  });

  const { billingInterval: _billingInterval, ...withoutInterval } = monthly;
  void _billingInterval;
  expect(() =>
    createProductCatalog([
      {
        ...withoutInterval,
        key: "invalid-subscription",
      },
    ]).getEnabled("invalid-subscription", "test"),
  ).toThrow("subscription billing interval is required");
});

it("rejects billing intervals on one-time products", () => {
  expect(() =>
    createProductCatalog([
      {
        ...product,
        billingInterval: "year",
      },
    ]).getEnabled("starter-pack", "test"),
  ).toThrow("one-time products cannot define a billing interval");
});

it("rejects duplicate key/version pairs", () => {
  expect(() => createProductCatalog([product, { ...product }])).toThrow(
    "duplicate product version",
  );
});

it("rejects disabled checkout and missing environment mappings", () => {
  expect(() =>
    createProductCatalog([{ ...product, enabled: false }]).getEnabled("starter-pack", "test"),
  ).toThrow("unknown or disabled product");
  expect(() =>
    createProductCatalog([product]).getEnabled("starter-pack", "production"),
  ).not.toThrow();
  expect(() =>
    createProductCatalog([
      { ...product, providerProductIdByEnvironment: { test: "prod_test_1" } },
    ]).getEnabled("starter-pack", "production"),
  ).toThrow("missing production provider product id");
});
