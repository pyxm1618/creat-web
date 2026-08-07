import type { ProductConfig } from "@/platform/config/types";

export const featuresConfig = {
  auth: { enabled: true, google: false, magicLink: true, password: false },
  email: { enabled: true },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { ga4: false, clarity: false, consentRequired: true },
} as const satisfies ProductConfig["features"];
