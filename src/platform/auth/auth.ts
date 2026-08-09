import "server-only";

import { featuresConfig } from "@/config/features.config";
import { siteConfig } from "@/config/site.config";
import { createPostgresAccountSubjectRepository } from "@/platform/accounts/postgres-account-subject-repository";
import { env } from "@/platform/config/env";
import { db } from "@/platform/database/application-database";
import * as schema from "@/platform/database/schema";
import { createLogger } from "@/platform/observability/logger";

import { createAuth } from "./create-auth";
import { sendMagicLinkEmail } from "./magic-link-email";

type AuthInstance = ReturnType<typeof createAuth>;
let authInstance: AuthInstance | undefined;

export function getAuth(): AuthInstance | null {
  if (!featuresConfig.auth.enabled) return null;
  if (authInstance) return authInstance;
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

  const subjects = createPostgresAccountSubjectRepository(db);
  const logger = createLogger({ component: "auth" });
  authInstance = createAuth({
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
    ensureAccountSubject: async (authUserId) => {
      await subjects.ensureForAuthUser(authUserId);
    },
    onAccountSubjectProvisioningError: ({ authUserId, error }) => {
      logger.error("account_subject_provisioning_failed", { authUserId, error });
    },
  });
  return authInstance;
}
