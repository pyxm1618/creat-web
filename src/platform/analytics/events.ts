export type AnalyticsEventName = "page_view" | "cta_click" | "feature_use";

export type AnalyticsEventInput = {
  name: AnalyticsEventName;
  properties?: Record<string, unknown>;
};

export type SanitizedAnalyticsEvent = {
  name: AnalyticsEventName;
  properties: Record<string, string | number | boolean>;
};

const MAX_STRING_LENGTH = 128;
const EMAIL_LIKE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i;
const SAFE_LOCALE = /^[A-Za-z0-9-]{2,16}$/;
const SAFE_TOKEN = /^[A-Za-z0-9 _./:-]{1,128}$/;

const EVENT_PROPERTY_ALLOWLIST: Record<AnalyticsEventName, readonly string[]> = {
  page_view: ["path", "locale"],
  cta_click: ["cta", "placement"],
  feature_use: ["feature", "action", "outcome"],
};

const SAFE_QUERY_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
]);

function sanitizeString(key: string, value: string): string | null {
  if (value.length === 0 || value.length > MAX_STRING_LENGTH || EMAIL_LIKE.test(value)) return null;

  if (key === "path") {
    if (!value.startsWith("/")) return null;
    try {
      const parsed = new URL(value, "https://analytics.invalid");
      return parsed.pathname;
    } catch {
      return null;
    }
  }

  if (key === "locale") return SAFE_LOCALE.test(value) ? value : null;
  return SAFE_TOKEN.test(value) ? value : null;
}

function sanitizeValue(key: string, value: unknown): string | number | boolean | null {
  if (typeof value === "string") return sanitizeString(key, value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function sanitizeAnalyticsEvent(input: AnalyticsEventInput): SanitizedAnalyticsEvent {
  const allowlist = EVENT_PROPERTY_ALLOWLIST[input.name];
  if (!allowlist) throw new Error(`Analytics event is not allowlisted: ${String(input.name)}`);

  const properties: Record<string, string | number | boolean> = {};
  for (const key of allowlist) {
    const sanitized = sanitizeValue(key, input.properties?.[key]);
    if (sanitized !== null) properties[key] = sanitized;
  }

  return { name: input.name, properties };
}

export function isAnalyticsLocationSafe(input: {
  pathname: string;
  search: string;
  hash: string;
}): boolean {
  if (
    EMAIL_LIKE.test(input.pathname) ||
    EMAIL_LIKE.test(input.search) ||
    EMAIL_LIKE.test(input.hash)
  ) {
    return false;
  }

  if (input.hash) return false;

  const params = new URLSearchParams(input.search);
  for (const [key, value] of params) {
    if (!SAFE_QUERY_KEYS.has(key)) return false;
    if (!SAFE_TOKEN.test(value) || EMAIL_LIKE.test(value)) return false;
  }

  return true;
}
