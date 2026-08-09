"use client";

import { useEffect, useSyncExternalStore } from "react";

const STORAGE_KEY = "creat-web:analytics-consent:v1";
const CONSENT_EVENT = "creat-web:analytics-consent-changed";
type Consent = "unknown" | "granted" | "denied";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    clarity?: ((...args: unknown[]) => void) & { q?: unknown[][] };
  }
}

function readConsent(): Consent {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "granted" || stored === "denied" ? stored : "unknown";
}

function serverConsent(): Consent {
  return "unknown";
}

function subscribeConsent(onStoreChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(CONSENT_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CONSENT_EVENT, onStoreChange);
  };
}

function persistConsent(consent: Exclude<Consent, "unknown">): void {
  window.localStorage.setItem(STORAGE_KEY, consent);
  window.dispatchEvent(new Event(CONSENT_EVENT));
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
  const storedConsent = useSyncExternalStore<Consent>(subscribeConsent, readConsent, serverConsent);
  const consent: Consent = consentRequired ? storedConsent : "granted";

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
        <button type="button" onClick={() => persistConsent("granted")}>
          Allow analytics
        </button>
        <button type="button" onClick={() => persistConsent("denied")}>
          Decline
        </button>
      </div>
    </aside>
  );
}
