import { existsSync, readFileSync } from "node:fs";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();
const boundaryRuleId = "creat-web/commerce-credits-boundary";

async function boundaryMessages(source: string, filePath: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result?.messages.filter((message) => message.ruleId === boundaryRuleId) ?? [];
}

describe("Commerce to Credits architecture boundary", () => {
  it.each([
    [
      "aliased implementation",
      'import { grantCredits } from "@/platform/credits/application/credit-service";',
      "src/platform/commerce/application/future-handler.ts",
    ],
    [
      "exact Credits barrel",
      'export * from "@/platform/credits";',
      "src/platform/commerce/domain/future-rule.ts",
    ],
    [
      "normalized alias traversal",
      'import { grantCredits } from "@/platform/commerce/../credits/application/credit-service";',
      "src/platform/commerce/providers/future-provider.ts",
    ],
    [
      "normalized nested relative traversal",
      'import { grantCredits } from "../../../credits/application/../application/credit-service";',
      "src/platform/commerce/providers/future/nested-provider.ts",
    ],
    [
      "static template dynamic import",
      "async function loadCredits() { return import(`@/platform/credits/application/credit-service`); }",
      "src/platform/commerce/application/future-handler.ts",
    ],
    [
      "static template CommonJS import",
      "const credits = require(`../../credits/application/credit-service`);",
      "src/platform/commerce/domain/future-rule.ts",
    ],
  ])("rejects a future %s from Commerce core", async (_name, source, filePath) => {
    expect(await boundaryMessages(source, filePath)).toHaveLength(1);
  });

  it("retains the platform-to-product module restriction in Commerce core", async () => {
    const [result] = await eslint.lintText(
      'import { productAction } from "@/modules/future-product/application/action";',
      { filePath: "src/platform/commerce/application/future-handler.ts" },
    );

    expect(result?.messages.some((message) => message.ruleId === "no-restricted-imports")).toBe(
      true,
    );
  });

  it("allows an explicit type-only Credits dependency from Commerce core", async () => {
    expect(
      await boundaryMessages(
        'import type { CreditReservation } from "@/platform/commerce/../credits/domain/types";',
        "src/platform/commerce/application/future-handler.ts",
      ),
    ).toEqual([]);
  });

  it.each([
    'const adapter = import("@/platform/credits/integration/commerce/credit-fulfillment");',
    'const adapter = import("@/platform/credits/integration/commerce/../commerce/credit-fulfillment");',
  ])(
    "allows only the public Credits integration entry from the composition root",
    async (source) => {
      expect(await boundaryMessages(source, "src/platform/commerce/commerce-runtime.ts")).toEqual(
        [],
      );
    },
  );

  it.each([
    'import { grantCredits } from "@/platform/credits/application/credit-service";',
    'import * as credits from "@/platform/credits";',
    "const credits = import(`../credits/domain/types`);",
    "const credits = require(`../credits/integration/commerce/../commerce/not-public`);",
  ])("rejects every other Credits runtime dependency from the composition root", async (source) => {
    expect(
      await boundaryMessages(source, "src/platform/commerce/commerce-runtime.ts"),
    ).toHaveLength(1);
  });

  it("allows the Credits integration adapter to depend on the Commerce port", async () => {
    expect(
      await boundaryMessages(
        'import type { OrderFulfillment } from "@/platform/commerce/application/order-fulfillment";',
        "src/platform/credits/integration/commerce/future-adapter.ts",
      ),
    ).toEqual([]);
  });

  it("keeps the real composition and adapter topology intact", async () => {
    const runtime = readFileSync("src/platform/commerce/commerce-runtime.ts", "utf8");
    const adapterPath = "src/platform/credits/integration/commerce/credit-fulfillment.ts";
    const adapter = readFileSync(adapterPath, "utf8");

    expect(runtime).toContain("@/platform/credits/integration/commerce/credit-fulfillment");
    expect(existsSync(adapterPath)).toBe(true);
    expect(adapter).toContain("@/platform/commerce/application/order-fulfillment");
    expect(existsSync("src/platform/commerce/fulfillment/credit-order-fulfillment.ts")).toBe(false);
    expect(runtime).not.toContain("@/platform/credits/application/commerce-handlers");
  });

  it("lints the real Commerce topology without boundary violations", async () => {
    const results = await eslint.lintFiles([
      "src/platform/commerce/application/**/*.{ts,tsx}",
      "src/platform/commerce/domain/**/*.{ts,tsx}",
      "src/platform/commerce/providers/**/*.{ts,tsx}",
      "src/platform/commerce/commerce-runtime.ts",
    ]);

    expect(
      results.flatMap((result) =>
        result.messages.filter((message) => message.ruleId === boundaryRuleId),
      ),
    ).toEqual([]);
  });
});
