"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "creat-web:analytics-consent:v1";
type Consent = "unknown" | "granted" | "denied";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    clarity?: ((...args: unknown[]) => void) & { q?: unknown[][] };
  }
}

function loadScript(id: string, src: string): void {
  if (document.getElementById(id)) return;
  const script = document.createElement("script");
  script.id = id;
  script.async = true;
  script.src = src;
  document.head.append(script);
}

function startGa4(measurementId: string): void {
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = (...args: unknown[]) => window.dataLayer?.push(args);
  window.gtag("js", new Date());
  window.gtag("consent", "default", { analytics_storage: "granted" });
  window.gtag("config", measurementId, { anonymize_ip: true });
  loadScript(
    "creat-web-ga4",
    `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`,
  );
}

function startClarity(projectId: string): void {
  const clarity = ((...args: unknown[]) => {
    clarity.q = clarity.q ?? [];
    clarity.q.push(args);
  }) as NonNullable<Window["clarity"]>;
  window.clarity = window.clarity ?? clarity;
  window.clarity("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
  loadScript("creat-web-clarity", `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`);
}

export function AnalyticsClient({
  ga4MeasurementId,
  clarityProjectId,
  consentRequired,
}: Readonly<{
  ga4MeasurementId?: string;
  clarityProjectId?: string;
  consentRequired: boolean;
}>) {
  const [consent, setConsent] = useState<Consent>(consentRequired ? "unknown" : "granted");

  useEffect(() => {
    if (!consentRequired) return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "granted" || stored === "denied") setConsent(stored);
  }, [consentRequired]);

  useEffect(() => {
    if (consent !== "granted") return;
    if (ga4MeasurementId) startGa4(ga4MeasurementId);
    if (clarityProjectId) startClarity(clarityProjectId);
  }, [clarityProjectId, consent, ga4MeasurementId]);

  if (!consentRequired || consent !== "unknown") return null;

  return (
    <aside className="analytics-consent" aria-label="Analytics consent">
      <p>Allow optional analytics to help improve this site?</p>
      <div>
        <button
          type="button"
          onClick={() => {
            window.localStorage.setItem(STORAGE_KEY, "granted");
            setConsent("granted");
          }}
        >
          Allow analytics
        </button>
        <button
          type="button"
          onClick={() => {
            window.localStorage.setItem(STORAGE_KEY, "denied");
            setConsent("denied");
          }}
        >
          Decline
        </button>
      </div>
    </aside>
  );
}
