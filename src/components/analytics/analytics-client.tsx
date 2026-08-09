"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  isAnalyticsLocationSafe,
  sanitizeAnalyticsEvent,
  type SanitizedAnalyticsEvent,
} from "@/platform/analytics/events";

const STORAGE_KEY = "creat-web:analytics-consent:v1";
const CONSENT_EVENT = "creat-web:analytics-consent-changed";
const SCRIPT_IDS = ["creat-web-ga4", "creat-web-clarity"] as const;
const ANALYTICS_COOKIE_PREFIXES = ["_ga", "_clck", "_clsk"] as const;
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

function emitAnalyticsEvent(event: SanitizedAnalyticsEvent): void {
  window.gtag?.("event", event.name, event.properties);
  window.clarity?.("event", event.name);
}

function startGa4(measurementId: string): void {
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = (...args: unknown[]) => window.dataLayer?.push(args);
  window.gtag("js", new Date());
  window.gtag("consent", "default", { analytics_storage: "granted" });
  window.gtag("config", measurementId, {
    anonymize_ip: true,
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
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

function clearAnalyticsCookies(): void {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=", 1)[0]?.trim();
    if (!name || !ANALYTICS_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
}

function stopAnalytics(): void {
  window.gtag?.("consent", "update", { analytics_storage: "denied" });
  window.clarity?.("consentv2", { ad_Storage: "denied", analytics_Storage: "denied" });
  for (const scriptId of SCRIPT_IDS) document.getElementById(scriptId)?.remove();
  clearAnalyticsCookies();
  window.dataLayer = [];
  delete window.gtag;
  delete window.clarity;
}

function ConsentPanel({
  currentConsent,
  onChoose,
  settings,
  onClose,
}: Readonly<{
  currentConsent: Consent;
  onChoose: (consent: Exclude<Consent, "unknown">) => void;
  settings: boolean;
  onClose?: () => void;
}>) {
  return (
    <aside
      className="analytics-consent"
      aria-label={settings ? "Analytics settings panel" : "Analytics consent"}
    >
      <p>Optional analytics help improve this site. They are never required for core product use.</p>
      <div>
        {currentConsent !== "granted" ? (
          <button type="button" onClick={() => onChoose("granted")}>
            Allow analytics
          </button>
        ) : null}
        {currentConsent === "unknown" ? (
          <button type="button" onClick={() => onChoose("denied")}>
            Decline
          </button>
        ) : null}
        {currentConsent === "granted" ? (
          <button type="button" onClick={() => onChoose("denied")}>
            Withdraw analytics consent
          </button>
        ) : null}
        {settings && onClose ? (
          <button type="button" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
    </aside>
  );
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const consent: Consent = consentRequired ? storedConsent : "granted";

  useEffect(() => {
    if (consent !== "granted") {
      stopAnalytics();
      return;
    }

    if (
      !isAnalyticsLocationSafe({
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      })
    ) {
      stopAnalytics();
      return;
    }

    if (ga4MeasurementId) startGa4(ga4MeasurementId);
    if (clarityProjectId) startClarity(clarityProjectId);

    emitAnalyticsEvent(
      sanitizeAnalyticsEvent({
        name: "page_view",
        properties: {
          path: window.location.pathname,
          locale: document.documentElement.lang || "en",
        },
      }),
    );

    return stopAnalytics;
  }, [clarityProjectId, consent, ga4MeasurementId]);

  const chooseConsent = (nextConsent: Exclude<Consent, "unknown">) => {
    persistConsent(nextConsent);
    setSettingsOpen(false);
  };

  if (!consentRequired) return null;

  if (consent === "unknown") {
    return <ConsentPanel currentConsent={consent} onChoose={chooseConsent} settings={false} />;
  }

  return (
    <>
      <button type="button" aria-label="Analytics settings" onClick={() => setSettingsOpen(true)}>
        Privacy settings
      </button>
      {settingsOpen ? (
        <ConsentPanel
          currentConsent={consent}
          onChoose={chooseConsent}
          settings
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}
