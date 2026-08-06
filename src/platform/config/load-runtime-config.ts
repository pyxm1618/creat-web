import { z } from "zod";

import type { ProductConfig } from "./types";

export type AppEnvironment = "local" | "test" | "staging" | "production";
export type EmailTransport = "disabled" | "test" | "resend";
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type RuntimeEnv = {
  readonly appEnv: AppEnvironment;
  readonly appOrigin: string;
  readonly databaseUrl: string;
  readonly betterAuthSecret: string | undefined;
  readonly emailTransport: EmailTransport;
  readonly emailFrom: string | undefined;
  readonly supportEmail: string | undefined;
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
  BETTER_AUTH_SECRET: z.string().optional(),
  EMAIL_TRANSPORT: z.enum(["test", "resend"]).optional(),
  EMAIL_FROM: z.string().optional(),
  SUPPORT_EMAIL: z.email().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  WAFFO_PRIVATE_KEY: z.string().optional(),
  GA4_MEASUREMENT_ID: z.string().optional(),
});

const TEST_ONLY_AUTH_SECRET = "test-only-better-auth-secret-never-use-in-production";

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return false;
  return /^(replace-me|changeme|example|todo|your[-_])/i.test(value.trim());
}

function requireSecret(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} are required`);
  if (isPlaceholder(value)) throw new Error("placeholder secret");
  return value;
}

function resolveAuthSecret(
  parsed: z.infer<typeof baseSchema>,
  authEnabled: boolean,
): string | undefined {
  if (!authEnabled) return undefined;

  const isNonProduction = parsed.APP_ENV === "local" || parsed.APP_ENV === "test";
  if (isNonProduction && !parsed.BETTER_AUTH_SECRET) return TEST_ONLY_AUTH_SECRET;
  if (!parsed.BETTER_AUTH_SECRET) throw new Error("Better Auth secret is required");
  if (isPlaceholder(parsed.BETTER_AUTH_SECRET)) throw new Error("placeholder secret");
  if (parsed.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("Better Auth secret must contain at least 32 characters");
  }
  return parsed.BETTER_AUTH_SECRET;
}

function resolveEmailTransport(
  parsed: z.infer<typeof baseSchema>,
  emailEnabled: boolean,
): EmailTransport {
  if (!emailEnabled) return "disabled";

  const isNonProduction = parsed.APP_ENV === "local" || parsed.APP_ENV === "test";
  const transport = parsed.EMAIL_TRANSPORT ?? (isNonProduction ? "test" : "resend");

  if (!isNonProduction && transport !== "resend") {
    throw new Error("staging and production email transport must use Resend");
  }

  return transport;
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

  const betterAuthSecret = resolveAuthSecret(parsed, features.auth.enabled);
  let googleClientId: string | undefined;
  let googleClientSecret: string | undefined;
  let resendApiKey: string | undefined;
  let emailFrom: string | undefined;
  let supportEmail: string | undefined;
  let waffoPrivateKey: string | undefined;
  let ga4MeasurementId: string | undefined;

  if (features.auth.google) {
    googleClientId = requireSecret(parsed.GOOGLE_CLIENT_ID, "Google credentials");
    googleClientSecret = requireSecret(parsed.GOOGLE_CLIENT_SECRET, "Google credentials");
  }

  const emailTransport = resolveEmailTransport(
    parsed,
    features.auth.magicLink || features.email.enabled,
  );
  if (emailTransport === "resend") {
    resendApiKey = requireSecret(parsed.RESEND_API_KEY, "Resend credentials");
    emailFrom = parsed.EMAIL_FROM;
    supportEmail = parsed.SUPPORT_EMAIL;
    if (!emailFrom || !supportEmail) {
      throw new Error("Email sender and support addresses are required");
    }
  } else if (emailTransport === "test") {
    emailFrom = parsed.EMAIL_FROM ?? "test@localhost.invalid";
    supportEmail = parsed.SUPPORT_EMAIL ?? "support@localhost.invalid";
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
    betterAuthSecret,
    emailTransport,
    emailFrom,
    supportEmail,
    googleClientId,
    googleClientSecret,
    resendApiKey,
    waffoPrivateKey,
    ga4MeasurementId,
  };
}
