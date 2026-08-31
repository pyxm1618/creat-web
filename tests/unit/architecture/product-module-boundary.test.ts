import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();
const boundaryRuleId = "creat-web-modules/product-module-boundary";

async function boundaryMessages(source: string, filePath: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result?.messages.filter((message) => message.ruleId === boundaryRuleId) ?? [];
}

describe("product module boundary", () => {
  it.each([
    ["aliased config import", 'import { siteConfig } from "@/config/site.config";'],
    ["relative config traversal", 'import { homeConfig } from "../../config/home.config";'],
    ["type-only config import", 'import type { HomeConfig } from "@/config/home.config";'],
    ["dynamic config import", 'const c = import("@/config/products.config");'],
  ])("rejects %s from inside a product module", async (_name, source) => {
    expect(await boundaryMessages(source, "src/modules/planner/domain/rules.ts")).toHaveLength(1);
  });

  it.each([
    ["product configuration", "src/config/home.config.tsx"],
    ["an app route", "src/app/(marketing)/page.tsx"],
    ["a shared component", "src/components/landing/landing-page.tsx"],
  ])("rejects reaching into module internals from %s", async (_name, filePath) => {
    expect(
      await boundaryMessages('import { Planner } from "@/modules/planner/ui/planner";', filePath),
    ).toHaveLength(1);
  });

  it.each([
    'import { Planner } from "@/modules/planner";',
    'import type { PlannerProps } from "@/modules/planner";',
    'import { Planner } from "@/modules/planner/index";',
  ])("allows the public entry from configuration", async (source) => {
    expect(await boundaryMessages(source, "src/config/home.config.tsx")).toEqual([]);
  });

  it("allows a module to use its own internals", async () => {
    expect(
      await boundaryMessages(
        'import { overlapWindows } from "@/modules/planner/domain/windows";',
        "src/modules/planner/ui/planner.tsx",
      ),
    ).toEqual([]);
  });

  it("forces one module to enter another through its public entry", async () => {
    expect(
      await boundaryMessages(
        'import { shared } from "@/modules/other/domain/shared";',
        "src/modules/planner/ui/planner.tsx",
      ),
    ).toHaveLength(1);
    expect(
      await boundaryMessages(
        'import { shared } from "@/modules/other";',
        "src/modules/planner/ui/planner.tsx",
      ),
    ).toEqual([]);
  });

  it.each([
    ['import { db } from "@/platform/database/application-database";', "platform capability"],
    ['import { card } from "@/components/ui/styles";', "shared style constant"],
  ])("allows a module to depend on %s", async (source) => {
    expect(await boundaryMessages(source, "src/modules/planner/ui/planner.tsx")).toEqual([]);
  });

  it("keeps platform code barred from product modules", async () => {
    const [result] = await eslint.lintText('import { Planner } from "@/modules/planner";', {
      filePath: "src/platform/seo/metadata.ts",
    });
    expect(result?.messages.some((message) => message.ruleId === "no-restricted-imports")).toBe(
      true,
    );
  });

  // Linting the whole tree takes several seconds on CI hardware, well past the
  // 5s default. verify:architecture covers the same ground, but running it here
  // surfaces a mis-scoped rule before the slower gates start.
  it("reports no boundary violation across the existing source tree", async () => {
    const results = await eslint.lintFiles(["src/**/*.{ts,tsx}"]);
    expect(
      results.flatMap((result) =>
        result.messages.filter((message) => message.ruleId === boundaryRuleId),
      ),
    ).toEqual([]);
  }, 30_000);
});
