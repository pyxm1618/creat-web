import "server-only";

import { getAuth } from "@/platform/auth/auth";
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
    invokeDeleteUser: (headers) => auth.api.deleteUser({ body: {}, headers, asResponse: true }),
  });

  service = createAccountDeletionService({
    database: db,
    subjects,
    coordinator: createPlatformAccountDeletionCoordinator(),
    identityDeletion,
  });
  return service;
}
