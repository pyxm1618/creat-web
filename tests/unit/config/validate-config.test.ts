import { describe, expect, it } from "vitest";

import { validateProductConfig } from "@/platform/config/validate-config";

const valid = {
  site: {
    slug: "sample-product",
    name: "Sample Product",
    canonicalOrigin: "https://example.com",
    defaultLocale: "en",
    supportedLocales: ["en"],
    localeLabels: { en: "English" },
    localePrefixStrategy: "as-needed",
  },
  features: {
    auth: { enabled: false, google: false, magicLink: false, password: false },
    email: { enabled: false },
    commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
    analytics: { enabled: false, ga4: false, clarity: false, consentRequired: true },
  },
} as const;

describe("validateProductConfig", () => {
  it("accepts a coherent deeply readonly configuration", () => {
    expect(validateProductConfig(valid).site.slug).toBe("sample-product");
  });

  it("rejects magic link without email transport", () => {
    expect(() =>
      validateProductConfig({
        ...valid,
        features: {
          ...valid.features,
          auth: { ...valid.features.auth, enabled: true, magicLink: true },
        },
      }),
    ).toThrow("magic link requires email transport");
  });

  it("rejects subscriptions when commerce is disabled", () => {
    expect(() =>
      validateProductConfig({
        ...valid,
        features: {
          ...valid.features,
          commerce: { ...valid.features.commerce, subscriptions: true },
        },
      }),
    ).toThrow("subscriptions require commerce");
  });

  it("accepts the commerce-enabled subscription release profile", () => {
    const configured = validateProductConfig({
      ...valid,
      features: {
        ...valid.features,
        commerce: { ...valid.features.commerce, enabled: true, subscriptions: true },
      },
    });

    expect(configured.features.commerce).toMatchObject({ enabled: true, subscriptions: true });
  });

  it("rejects credits when commerce is disabled", () => {
    expect(() =>
      validateProductConfig({
        ...valid,
        features: {
          ...valid.features,
          commerce: { ...valid.features.commerce, credits: true },
        },
      }),
    ).toThrow("credits require commerce");
  });

  it("rejects an enabled analytics provider when analytics is off", () => {
    expect(() =>
      validateProductConfig({
        ...valid,
        features: {
          ...valid.features,
          analytics: { ...valid.features.analytics, ga4: true },
        },
      }),
    ).toThrow("analytics providers require analytics");
  });

  it("rejects unsupported default locales", () => {
    expect(() =>
      validateProductConfig({
        ...valid,
        site: { ...valid.site, defaultLocale: "de" },
      }),
    ).toThrow("default locale must be supported");
  });

  it("rejects non-HTTPS production origins", () => {
    expect(() =>
      validateProductConfig({
        ...valid,
        site: { ...valid.site, canonicalOrigin: "http://localhost:3000" },
      }),
    ).toThrow("canonical origin must use production HTTPS");
  });
});
