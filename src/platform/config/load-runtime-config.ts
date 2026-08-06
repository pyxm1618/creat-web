import { z } from "zod";

import type { ProductConfig } from "./types";

export type AppEnvironment = "local" | "test" | "staging" | "production";
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type RuntimeEnv = {
  readonly appEnv: AppEnvironment;
  readonly appOrigin: string;
  readonly databaseUrl: string;
  readonly googleClientId: string | undefined;
  readonly googleClientSecret: string | undefined;
  readonly resendApiKey: string | undefined;
  readonly waffoPrivateKey: string | undefined;
  readonly ga4MeasurementId: string | undefined;
};

const baseSchema = z.object({
  APP_ENV: z.enum(["local", "test", "staging", "production"]),
  APP_ORIGIN: z.url(),
  DATABASE_URL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  WAFFO_PRIVATE_KEY: z.string().optional(),
  GA4_MEASUREMENT_ID: z.string().optional(),
});

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return false;
  return /^(replace-me|changeme|example|todo|your[-_])/i.test(value.trim());
}

function requireSecret(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} are required`);
  if (isPlaceholder(value)) throw new Error("placeholder secret");
  return value;
}

export function loadRuntimeEnv(
  source: EnvironmentSource,
  features: ProductConfig["features"],
): RuntimeEnv {
  const parsed = baseSchema.parse(source);
  const origin = new URL(parsed.APP_ORIGIN);

  if (
    (parsed.APP_ENV === "staging" || parsed.APP_ENV === "production") &&
    origin.protocol !== "https:"
  ) {
    throw new Error("APP_ORIGIN must use HTTPS");
  }

  let googleClientId: string | undefined;
  let googleClientSecret: string | undefined;
  let resendApiKey: string | undefined;
  let waffoPrivateKey: string | undefined;
  let ga4MeasurementId: string | undefined;

  if (features.auth.google) {
    googleClientId = requireSecret(parsed.GOOGLE_CLIENT_ID, "Google credentials");
    googleClientSecret = requireSecret(parsed.GOOGLE_CLIENT_SECRET, "Google credentials");
  }

  if (features.auth.magicLink || features.email.enabled) {
    resendApiKey = requireSecret(parsed.RESEND_API_KEY, "Resend credentials");
  }

  if (features.commerce.enabled) {
    waffoPrivateKey = requireSecret(parsed.WAFFO_PRIVATE_KEY, "Waffo credentials");
  }

  if (features.analytics.ga4) {
    ga4MeasurementId = requireSecret(parsed.GA4_MEASUREMENT_ID, "GA4 configuration");
  }

  return {
    appEnv: parsed.APP_ENV,
    appOrigin: parsed.APP_ORIGIN,
    databaseUrl: parsed.DATABASE_URL,
    googleClientId,
    googleClientSecret,
    resendApiKey,
    waffoPrivateKey,
    ga4MeasurementId,
  };
}
