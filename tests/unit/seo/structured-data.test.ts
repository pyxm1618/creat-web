import { expect, it } from "vitest";

import { serializeJsonLd, webApplicationJsonLd } from "@/platform/seo/structured-data";

it("escapes script-breaking user text", () => {
  expect(serializeJsonLd({ name: "</script><script>alert(1)</script>" })).not.toContain(
    "</script>",
  );
});

it("requires visible offer data before emitting price", () => {
  expect(() =>
    webApplicationJsonLd({
      name: "Tool",
      url: "https://example.com",
      visiblePrice: false,
      price: "9.00",
      currency: "USD",
    }),
  ).toThrow("visible offer required");
});

it("emits offer only when the visible page includes matching price data", () => {
  const value = webApplicationJsonLd({
    name: "Tool",
    url: "https://example.com",
    visiblePrice: true,
    price: "9.00",
    currency: "USD",
  });
  expect(value).toMatchObject({ offers: { price: "9.00", priceCurrency: "USD" } });
});
