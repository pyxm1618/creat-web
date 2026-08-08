import { expect, it } from "vitest";

import { metadataOrigin, seoEnvironmentPolicy } from "@/platform/seo/environment-policy";

it("forces non-production to noindex without canonical or sitemap", () => {
  expect(seoEnvironmentPolicy("staging")).toEqual({
    index: false,
    follow: false,
    emitSitemap: false,
    emitCanonical: false,
  });
  expect(seoEnvironmentPolicy("test").emitCanonical).toBe(false);
});

it("allows indexing only in production", () => {
  expect(seoEnvironmentPolicy("production")).toEqual({
    index: true,
    follow: true,
    emitSitemap: true,
    emitCanonical: true,
  });
});

it("uses deployment origin outside production and canonical origin in production", () => {
  expect(
    metadataOrigin({
      mode: "staging",
      appOrigin: "https://preview.example.test",
      canonicalOrigin: "https://example.com",
    }).origin,
  ).toBe("https://preview.example.test");
  expect(
    metadataOrigin({
      mode: "production",
      appOrigin: "https://preview.example.test",
      canonicalOrigin: "https://example.com",
    }).origin,
  ).toBe("https://example.com");
});
