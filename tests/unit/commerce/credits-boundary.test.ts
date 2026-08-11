import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function restrictedImportMessages(source: string, filePath: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result?.messages.filter(
    (message) =>
      message.ruleId === "no-restricted-imports" || message.ruleId === "no-restricted-syntax",
  );
}

describe("Commerce to Credits architecture boundary", () => {
  it.each([
    "src/platform/commerce/application/future-handler.ts",
    "src/platform/commerce/domain/future-rule.ts",
    "src/platform/commerce/providers/future-provider.ts",
    "src/platform/commerce/providers/future/nested-provider.ts",
  ])("rejects a future runtime import from %s", async (filePath) => {
    const messages = await restrictedImportMessages(
      'import { grantCredits } from "@/platform/credits/application/credit-service";',
      filePath,
    );

    expect(messages).toHaveLength(1);
  });

  it("rejects a relative import that bypasses the platform alias", async () => {
    const messages = await restrictedImportMessages(
      'import { grantCredits } from "../../credits/application/credit-service";',
      "src/platform/commerce/application/future-handler.ts",
    );

    expect(messages).toHaveLength(1);
  });

  it("rejects a dynamic Credits implementation import from Commerce core", async () => {
    const messages = await restrictedImportMessages(
      'async function loadCredits() { return import("@/platform/credits/application/credit-service"); }',
      "src/platform/commerce/application/future-handler.ts",
    );

    expect(messages).toHaveLength(1);
  });

  it("rejects a CommonJS Credits implementation import from Commerce core", async () => {
    const messages = await restrictedImportMessages(
      'const credits = require("@/platform/credits/application/credit-service");',
      "src/platform/commerce/providers/future-provider.ts",
    );

    expect(messages).toHaveLength(1);
  });

  it("retains the platform-to-product module restriction in Commerce core", async () => {
    const messages = await restrictedImportMessages(
      'import { productAction } from "@/modules/future-product/application/action";',
      "src/platform/commerce/application/future-handler.ts",
    );

    expect(messages).toHaveLength(1);
  });

  it("allows an explicit type-only Credits dependency", async () => {
    const messages = await restrictedImportMessages(
      'import type { CreditReservation } from "@/platform/credits/domain/types";',
      "src/platform/commerce/application/future-handler.ts",
    );

    expect(messages).toEqual([]);
  });

  it("allows the Commerce composition root to wire the Credits adapter", async () => {
    const messages = await restrictedImportMessages(
      'const adapter = import("@/platform/credits/integration/commerce/credit-fulfillment");',
      "src/platform/commerce/commerce-runtime.ts",
    );

    expect(messages).toEqual([]);
  });

  it("allows the Credits integration adapter to depend on a Commerce port", async () => {
    const messages = await restrictedImportMessages(
      'import type { OrderFulfillment } from "@/platform/commerce/application/order-fulfillment";',
      "src/platform/credits/integration/commerce/future-adapter.ts",
    );

    expect(messages).toEqual([]);
  });
});
