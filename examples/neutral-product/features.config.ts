import type { ProductConfig } from "@/platform/config/types";

const enabledTestFeaturesConfig = {
  auth: { enabled: true, google: false, magicLink: true, password: false },
  email: { enabled: true },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { enabled: true, ga4: true, clarity: true, consentRequired: true },
} as const satisfies ProductConfig["features"];

const neutralFeaturesConfig = {
  auth: { enabled: true, google: true, magicLink: true, password: false },
  email: { enabled: true },
  commerce: { enabled: true, oneTime: true, subscriptions: true, credits: true },
  analytics: { enabled: false, ga4: false, clarity: false, consentRequired: true },
} as const satisfies ProductConfig["features"];

const useEnabledTestProfile =
  process.env.APP_ENV === "test" && process.env.CREAT_WEB_E2E_ENABLED_FEATURES === "1";

export const featuresConfig = useEnabledTestProfile
  ? enabledTestFeaturesConfig
  : neutralFeaturesConfig;
