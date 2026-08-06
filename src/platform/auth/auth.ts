import "server-only";

import { featuresConfig } from "@/config/features.config";
import { siteConfig } from "@/config/site.config";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";
import * as schema from "@/platform/database/schema";

import { createAuth } from "./create-auth";
import { sendMagicLinkEmail } from "./magic-link-email";

if (!env.betterAuthSecret) {
  throw new Error("Better Auth secret is unavailable while authentication is enabled");
}

const google =
  featuresConfig.auth.google && env.googleClientId && env.googleClientSecret
    ? {
        clientId: env.googleClientId,
        clientSecret: env.googleClientSecret,
      }
    : undefined;

export const auth = createAuth({
  appName: siteConfig.name,
  baseURL: env.appOrigin,
  secret: env.betterAuthSecret,
  cookiePrefix: siteConfig.slug,
  database: db,
  schema,
  ...(google ? { google } : {}),
  sendMagicLink: async ({ email, token, returnTo }) => {
    await sendMagicLinkEmail({ email, token, returnTo });
  },
});
