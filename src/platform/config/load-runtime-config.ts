import { z } from "zod";

import type { ProductConfig } from "./types";

export type AppEnvironment = "local" | "test" | "staging" | "production";
export type VercelEnvironment = "development" | "preview" | "production";
export type EmailTransport = "disabled" | "test" | "resend";
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type RuntimeEnv = {
  readonly appEnv: AppEnvironment;
  readonly vercelEnv: VercelEnvironment | undefined;
  readonly appOrigin: string;
  readonly databaseUrl: string;
  readonly betterAuthSecret: string | undefined;
  readonly cronSecret: string | undefined;
  readonly emailTransport: EmailTransport;
  readonly emailFrom: string | undefined;
  readonly supportEmail: string | undefined;
  readonly testEmailDirectory: string | undefined;
  readonly googleClientId: string | undefined;
  readonly googleClientSecret: string | undefined;
  readonly resendApiKey: string | undefined;
  readonly waffoMerchantId: string | undefined;
  readonly waffoPrivateKey: string | undefined;
  readonly waffoStoreId: string | undefined;
  readonly waffoWebhookTestPublicKey: string | undefined;
  readonly waffoWebhookProdPublicKey: string | undefined;
  readonly waffoContractVerified: boolean;
  readonly commerceRetentionKey: string | undefined;
  readonly commerceRetentionKeyId: string | undefined;
  readonly ga4MeasurementId: string | undefined;
};

const baseSchema = z.object({
  APP_ENV: z.enum(["local", "test", "staging", "production"]),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  APP_ORIGIN: z.url(),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  EMAIL_TRANSPORT: z.enum(["test", "resend"]).optional(),
  EMAIL_FROM: z.string().optional(),
  SUPPORT_EMAIL: z.email().optional(),
  TEST_EMAIL_DIR: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  WAFFO_MERCHANT_ID: z.string().optional(),
  WAFFO_PRIVATE_KEY: z.string().optional(),
  WAFFO_STORE_ID: z.string().optional(),
  WAFFO_WEBHOOK_TEST_PUBLIC_KEY: z.string().optional(),
  WAFFO_WEBHOOK_PROD_PUBLIC_KEY: z.string().optional(),
  WAFFO_CONTRACT_VERIFIED: z.enum(["0", "1"]).optional(),
  COMMERCE_RETENTION_KEY: z.string().optional(),
  COMMERCE_RETENTION_KEY_ID: z.string().optional(),
  GA4_MEASUREMENT_ID: z.string().optional(),
});

const TEST_ONLY_AUTH_SECRET = "test-only-better-auth-secret-never-use-in-production";
const TEST_ONLY_CRON_SECRET = "test-only-cron-secret-never-use-in-production";

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return false;
  return /^(replace-me|changeme|example|todo|your[-_])/i.test(value.trim());
}

function requireSecret(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} are required`);
  if (isPlaceholder(value)) throw new Error("placeholder secret");
  return value;
}

function assertDeploymentEnvironment(parsed: z.infer<typeof baseSchema>): void {
  if (!parsed.VERCEL_ENV) return;

  const expected: Record<VercelEnvironment, AppEnvironment> = {
    development: "local",
    preview: "staging",
    production: "production",
  };
  if (parsed.APP_ENV !== expected[parsed.VERCEL_ENV]) {
    throw new Error(
      `VERCEL_ENV=${parsed.VERCEL_ENV} requires APP_ENV=${expected[parsed.VERCEL_ENV]}`,
    );
  }
  if (parsed.APP_ENV === "test") {
    throw new Error("APP_ENV=test is forbidden on Vercel deployments");
  }
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

function resolveCronSecret(
  parsed: z.infer<typeof baseSchema>,
  enabled: boolean,
): string | undefined {
  if (!enabled) return undefined;
  if (parsed.APP_ENV === "local" || parsed.APP_ENV === "test") {
    return parsed.CRON_SECRET ?? TEST_ONLY_CRON_SECRET;
  }
  const value = requireSecret(parsed.CRON_SECRET, "Cron secret");
  if (value.length < 16) throw new Error("Cron secret must contain at least 16 characters");
  return value;
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

function validateRetentionKey(value: string): string {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error("COMMERCE_RETENTION_KEY must be base64 for exactly 32 bytes");
  }
  return value;
}

export function loadRuntimeEnv(
  source: EnvironmentSource,
  features: ProductConfig["features"],
): RuntimeEnv {
  const parsed = baseSchema.parse(source);
  assertDeploymentEnvironment(parsed);
  const origin = new URL(parsed.APP_ORIGIN);

  if (
    (parsed.APP_ENV === "staging" || parsed.APP_ENV === "production") &&
    origin.protocol !== "https:"
  ) {
    throw new Error("APP_ORIGIN must use HTTPS");
  }
  if ((parsed.APP_ENV === "staging" || parsed.APP_ENV === "production") && parsed.TEST_EMAIL_DIR) {
    throw new Error("TEST_EMAIL_DIR is forbidden outside local and test environments");
  }

  const betterAuthSecret = resolveAuthSecret(parsed, features.auth.enabled);
  const cronSecret = resolveCronSecret(parsed, features.auth.enabled || features.commerce.enabled);
  let googleClientId: string | undefined;
  let googleClientSecret: string | undefined;
  let resendApiKey: string | undefined;
  let emailFrom: string | undefined;
  let supportEmail: string | undefined;
  let testEmailDirectory: string | undefined;
  let waffoMerchantId: string | undefined;
  let waffoPrivateKey: string | undefined;
  let waffoStoreId: string | undefined;
  let waffoWebhookTestPublicKey: string | undefined;
  let waffoWebhookProdPublicKey: string | undefined;
  let commerceRetentionKey: string | undefined;
  let commerceRetentionKeyId: string | undefined;
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
    testEmailDirectory = parsed.TEST_EMAIL_DIR ?? "/tmp/creat-web-test-emails";
  }

  if (features.commerce.enabled) {
    waffoMerchantId = requireSecret(parsed.WAFFO_MERCHANT_ID, "Waffo merchant configuration");
    waffoPrivateKey = requireSecret(parsed.WAFFO_PRIVATE_KEY, "Waffo credentials");
    waffoStoreId = requireSecret(parsed.WAFFO_STORE_ID, "Waffo store configuration");
    waffoWebhookTestPublicKey = requireSecret(
      parsed.WAFFO_WEBHOOK_TEST_PUBLIC_KEY,
      "Waffo test webhook public key",
    );
    if (parsed.APP_ENV === "production") {
      waffoWebhookProdPublicKey = requireSecret(
        parsed.WAFFO_WEBHOOK_PROD_PUBLIC_KEY,
        "Waffo production webhook public key",
      );
    } else {
      waffoWebhookProdPublicKey = parsed.WAFFO_WEBHOOK_PROD_PUBLIC_KEY;
    }
    commerceRetentionKey = validateRetentionKey(
      requireSecret(parsed.COMMERCE_RETENTION_KEY, "Commerce retention key"),
    );
    commerceRetentionKeyId = requireSecret(
      parsed.COMMERCE_RETENTION_KEY_ID,
      "Commerce retention key id",
    );
    if (
      (parsed.APP_ENV === "staging" || parsed.APP_ENV === "production") &&
      parsed.WAFFO_CONTRACT_VERIFIED !== "1"
    ) {
      throw new Error("Waffo contract must be verified before deployed commerce is enabled");
    }
  }

  if (features.analytics.ga4) {
    ga4MeasurementId = requireSecret(parsed.GA4_MEASUREMENT_ID, "GA4 configuration");
  }

  return {
    appEnv: parsed.APP_ENV,
    vercelEnv: parsed.VERCEL_ENV,
    appOrigin: parsed.APP_ORIGIN,
    databaseUrl: parsed.DATABASE_URL,
    betterAuthSecret,
    cronSecret,
    emailTransport,
    emailFrom,
    supportEmail,
    testEmailDirectory,
    googleClientId,
    googleClientSecret,
    resendApiKey,
    waffoMerchantId,
    waffoPrivateKey,
    waffoStoreId,
    waffoWebhookTestPublicKey,
    waffoWebhookProdPublicKey,
    waffoContractVerified: parsed.WAFFO_CONTRACT_VERIFIED === "1",
    commerceRetentionKey,
    commerceRetentionKeyId,
    ga4MeasurementId,
  };
}
