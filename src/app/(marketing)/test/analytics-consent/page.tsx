import { notFound } from "next/navigation";

import { AnalyticsClient } from "@/components/analytics/analytics-client";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default function AnalyticsConsentTestPage() {
  if (process.env.APP_ENV !== "test") notFound();
  return (
    <main>
      <h1>Analytics consent test harness</h1>
      <AnalyticsClient ga4MeasurementId="G-TESTCONSENT" clarityProjectId="test-consent" consentRequired />
    </main>
  );
}
