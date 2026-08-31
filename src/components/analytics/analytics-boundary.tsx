import { featuresConfig } from "@/config/features.config";
import { env } from "@/platform/config/env";

import { AnalyticsClient } from "./analytics-client";

export function AnalyticsBoundary() {
  if (!featuresConfig.analytics.enabled) return null;

  return (
    <AnalyticsClient
      consentRequired={featuresConfig.analytics.consentRequired}
      {...(featuresConfig.analytics.ga4 && env.ga4MeasurementId
        ? { ga4MeasurementId: env.ga4MeasurementId }
        : {})}
      {...(featuresConfig.analytics.clarity && env.clarityProjectId
        ? { clarityProjectId: env.clarityProjectId }
        : {})}
    />
  );
}
