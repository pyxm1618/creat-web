import "server-only";

import { createPostgresAccountSubjectRepository } from "@/platform/accounts/postgres-account-subject-repository";
import { ensureActiveAccountSubject } from "@/platform/accounts/resolve-account-subject";
import { db } from "@/platform/database/application-database";

import { auth } from "./auth";

const subjects = createPostgresAccountSubjectRepository(db);

export async function getAccountContext(requestHeaders: Headers) {
  const result = await auth.api.getSession({ headers: requestHeaders });
  if (!result) return null;

  const subject = await ensureActiveAccountSubject(subjects, result.user.id);
  return {
    user: result.user,
    session: result.session,
    subject,
  } as const;
}

export async function requireAccountContext(requestHeaders: Headers) {
  const context = await getAccountContext(requestHeaders);
  if (!context) throw new Error("authentication required");
  return context;
}
