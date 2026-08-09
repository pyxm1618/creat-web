import type { ProductConfig } from "@/platform/config/types";

export const featuresConfig = {
  auth: { enabled: true, google: true, magicLink: true, password: false },
  email: { enabled: true },
  commerce: { enabled: true, oneTime: true, subscriptions: true, credits: true },
  analytics: { enabled: false, ga4: false, clarity: false, consentRequired: true },
} as const satisfies ProductConfig["features"];
