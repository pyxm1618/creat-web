import { z } from "zod";

import type { ProductConfig } from "./types";

const localeSchema = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);

const productConfigSchema = z.object({
  site: z.object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(2),
    canonicalOrigin: z.url(),
    defaultLocale: localeSchema,
    supportedLocales: z.array(localeSchema).min(1),
    localeLabels: z.record(z.string(), z.string().trim().min(1)),
    localePrefixStrategy: z.literal("as-needed"),
  }),
  features: z.object({
    auth: z.object({
      enabled: z.boolean(),
      google: z.boolean(),
      magicLink: z.boolean(),
      password: z.literal(false),
    }),
    email: z.object({ enabled: z.boolean() }),
    commerce: z.object({
      enabled: z.boolean(),
      oneTime: z.boolean(),
      subscriptions: z.boolean(),
      credits: z.boolean(),
    }),
    analytics: z.object({
      enabled: z.boolean(),
      ga4: z.boolean(),
      clarity: z.boolean(),
      consentRequired: z.boolean(),
    }),
  }),
});

export function validateProductConfig(input: ProductConfig): ProductConfig {
  const parsed = productConfigSchema.parse(input);

  if (!parsed.site.supportedLocales.includes(parsed.site.defaultLocale)) {
    throw new Error("default locale must be supported");
  }
  if (new Set(parsed.site.supportedLocales).size !== parsed.site.supportedLocales.length) {
    throw new Error("supported locales must be unique");
  }
  for (const locale of parsed.site.supportedLocales) {
    if (!parsed.site.localeLabels[locale]) throw new Error(`missing locale label: ${locale}`);
  }

  if (parsed.features.auth.google && !parsed.features.auth.enabled) {
    throw new Error("Google sign-in requires auth");
  }
  if (parsed.features.auth.magicLink && !parsed.features.auth.enabled) {
    throw new Error("magic link requires auth");
  }
  if (parsed.features.auth.magicLink && !parsed.features.email.enabled) {
    throw new Error("magic link requires email transport");
  }
  if (parsed.features.commerce.oneTime && !parsed.features.commerce.enabled) {
    throw new Error("one-time purchases require commerce");
  }
  if (parsed.features.commerce.subscriptions && !parsed.features.commerce.enabled) {
    throw new Error("subscriptions require commerce");
  }
  if (parsed.features.commerce.credits && !parsed.features.commerce.enabled) {
    throw new Error("credits require commerce");
  }
  if (
    (parsed.features.analytics.ga4 || parsed.features.analytics.clarity) &&
    !parsed.features.analytics.enabled
  ) {
    throw new Error("analytics providers require analytics");
  }

  const origin = new URL(parsed.site.canonicalOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.hostname === "localhost" ||
    origin.hostname === "127.0.0.1"
  ) {
    throw new Error("canonical origin must use production HTTPS");
  }

  return parsed;
}
