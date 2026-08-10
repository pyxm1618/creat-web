import type { ProductConfig } from "@/platform/config/types";

const enabledTestFeaturesConfig = {
  auth: { enabled: true, google: false, magicLink: true, password: false },
  email: { enabled: true },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { enabled: true, ga4: true, clarity: true, consentRequired: true },
} as const satisfies ProductConfig["features"];

const commerceEnabledTestFeaturesConfig = {
  ...enabledTestFeaturesConfig,
  commerce: { enabled: true, oneTime: false, subscriptions: true, credits: false },
} as const satisfies ProductConfig["features"];

const neutralFeaturesConfig = {
  auth: { enabled: false, google: false, magicLink: false, password: false },
  email: { enabled: false },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { enabled: false, ga4: false, clarity: false, consentRequired: true },
} as const satisfies ProductConfig["features"];

const useEnabledTestProfile =
  process.env.APP_ENV === "test" && process.env.CREAT_WEB_E2E_ENABLED_FEATURES === "1";
const useCommerceEnabledTestProfile =
  useEnabledTestProfile && process.env.CREAT_WEB_E2E_COMMERCE === "1";

export const featuresConfig = useCommerceEnabledTestProfile
  ? commerceEnabledTestFeaturesConfig
  : useEnabledTestProfile
    ? enabledTestFeaturesConfig
    : neutralFeaturesConfig;
