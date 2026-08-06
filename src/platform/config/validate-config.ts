import { z } from "zod";

import type { ProductConfig } from "./types";

const productConfigSchema = z.object({
  site: z.object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(2),
    canonicalOrigin: z.url(),
    defaultLocale: z.string().min(2),
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
      ga4: z.boolean(),
      clarity: z.boolean(),
      consentRequired: z.boolean(),
    }),
  }),
});

export function validateProductConfig(input: ProductConfig): ProductConfig {
  const parsed = productConfigSchema.parse(input);

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
