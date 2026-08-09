import { expect, it } from "vitest";

import { TEMPLATE_VERSION } from "@/config/template-version";

it("uses semantic version format", () => {
  expect(TEMPLATE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
