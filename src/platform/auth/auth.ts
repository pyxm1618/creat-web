import "server-only";

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { magicLink } from "better-auth/plugins";

import { featuresConfig } from "@/config/features.config";
import { siteConfig } from "@/config/site.config";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";
import * as schema from "@/platform/database/schema";

import { sendMagicLinkEmail } from "./magic-link-email";

if (!env.betterAuthSecret) {
  throw new Error("Better Auth secret is unavailable while authentication is enabled");
}

const socialProviders =
  featuresConfig.auth.google && env.googleClientId && env.googleClientSecret
    ? {
        google: {
          clientId: env.googleClientId,
          clientSecret: env.googleClientSecret,
        },
      }
    : {};

export const auth = betterAuth({
  appName: siteConfig.name,
  baseURL: env.appOrigin,
  secret: env.betterAuthSecret,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  trustedOrigins: [env.appOrigin],
  emailAndPassword: { enabled: false },
  socialProviders,
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    freshAge: 60 * 15,
  },
  verification: {
    storeIdentifier: "hashed",
    storeInDatabase: true,
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    modelName: "rateLimit",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/magic-link": { window: 60, max: 5 },
    },
  },
  advanced: {
    cookiePrefix: siteConfig.slug,
  },
  plugins: [
    magicLink({
      expiresIn: 60 * 10,
      storeToken: "hashed",
      sendMagicLink: async ({ email, token, metadata }) => {
        const returnTo =
          metadata && typeof metadata === "object" && "returnTo" in metadata
            ? String(metadata.returnTo)
            : "/account";
        await sendMagicLinkEmail({ email, token, returnTo });
      },
    }),
  ],
});
