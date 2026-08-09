import { existsSync, readFileSync } from "node:fs";

import { expect, it } from "vitest";

it("keeps the Commerce runtime wired to a Credits integration adapter", () => {
  const runtime = readFileSync("src/platform/commerce/commerce-runtime.ts", "utf8");

  expect(runtime).toContain("@/platform/credits/integration/commerce/credit-fulfillment");
  expect(existsSync("src/platform/credits/integration/commerce/credit-fulfillment.ts")).toBe(true);
  expect(existsSync("src/platform/commerce/fulfillment/credit-order-fulfillment.ts")).toBe(false);
  expect(runtime).not.toContain("@/platform/credits/application/commerce-handlers");
});
