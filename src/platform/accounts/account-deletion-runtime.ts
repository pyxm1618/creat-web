import "server-only";

import { auth } from "@/platform/auth/auth";
import { db } from "@/platform/database/application-database";

import { createAccountDeletionService } from "./account-deletion-service";
import { createBetterAuthIdentityDeletion } from "./better-auth-identity-deletion";
import { createPlatformAccountDeletionCoordinator } from "./platform-account-deletion-coordinator";
import { createPostgresAccountSubjectRepository } from "./postgres-account-subject-repository";

const subjects = createPostgresAccountSubjectRepository(db);
const identityDeletion = createBetterAuthIdentityDeletion({
  database: db,
  invokeDeleteUser: (headers) => auth.api.deleteUser({ body: {}, headers, asResponse: true }),
});

export const accountDeletionService = createAccountDeletionService({
  database: db,
  subjects,
  coordinator: createPlatformAccountDeletionCoordinator(),
  identityDeletion,
});
