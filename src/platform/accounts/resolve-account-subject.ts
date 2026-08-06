import type { AccountSubject } from "./account-subject";
import type { AccountSubjectRepository } from "./account-subject-repository";

export async function ensureActiveAccountSubject(
  repository: AccountSubjectRepository,
  authUserId: string,
): Promise<AccountSubject> {
  const existing = await repository.getActiveByAuthUserId(authUserId);
  if (existing) return existing;

  const repaired = await repository.ensureForAuthUser(authUserId);
  if (repaired.status !== "active") {
    throw new Error("active account subject required");
  }
  return repaired;
}
