import { expect, it } from "vitest";

import { validateLinkGraph } from "@/platform/seo/link-graph";

it("reports broken targets and orphan indexable routes", () => {
  const report = validateLinkGraph(["/", "/guide"], [{ from: "/", to: "/missing" }]);
  expect(report.broken).toEqual(["/missing"]);
  expect(report.orphans).toEqual(["/guide"]);
});

it("accepts an internally linked indexable route", () => {
  expect(
    validateLinkGraph(
      ["/", "/pricing"],
      [
        { from: "/", to: "/pricing" },
        { from: "/pricing", to: "/" },
      ],
    ),
  ).toEqual({ broken: [], orphans: [] });
});
