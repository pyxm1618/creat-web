import "server-only";

import { makeSignature } from "better-auth/crypto";

import { getAuth } from "@/platform/auth/auth";
import { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import { db } from "@/platform/database/application-database";

import { createAccountDeletionService } from "./account-deletion-service";
import { createBetterAuthIdentityDeletion } from "./better-auth-identity-deletion";
import { createPlatformAccountDeletionCoordinator } from "./platform-account-deletion-coordinator";
import { createPostgresAccountSubjectRepository } from "./postgres-account-subject-repository";

type AccountDeletionService = ReturnType<typeof createAccountDeletionService>;
let service: AccountDeletionService | undefined;

export function getAccountDeletionService(): AccountDeletionService | null {
  const auth = getAuth();
  if (!auth) return null;
  if (service) return service;

  const subjects = createPostgresAccountSubjectRepository(db);
  const identityDeletion = createBetterAuthIdentityDeletion({
    database: db,
    invokeDeleteUser: async (workerSessionToken) => {
      const context = await auth.$context;
      const signature = await makeSignature(workerSessionToken, context.secret);
      const headers = new Headers({
        cookie: `${context.authCookies.sessionToken.name}=${workerSessionToken}.${signature}`,
      });
      return auth.api.deleteUser({ body: {}, headers, asResponse: true });
    },
  });

  service = createAccountDeletionService({
    database: db,
    subjects,
    coordinator: createPlatformAccountDeletionCoordinator({
      database: db,
      getCommerce: getCommerceRuntime,
    }),
    identityDeletion,
  });
  return service;
}
