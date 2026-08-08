import { expect, it } from "vitest";

import { canonicalUrl } from "@/platform/seo/canonical";

it("normalizes path and strips query and fragment data", () => {
  expect(
    canonicalUrl("https://example.com/", "/Guide/?utm_source=x#section", new URLSearchParams()),
  ).toBe("https://example.com/Guide");
});

it("rejects a canonical outside the configured origin", () => {
  expect(() => canonicalUrl("https://example.com", "https://evil.example/page")).toThrow(
    "canonical origin mismatch",
  );
});
