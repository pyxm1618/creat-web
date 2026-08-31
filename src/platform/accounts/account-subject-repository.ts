import type { AccountSubject } from "./account-subject";

export interface AccountSubjectRepository {
  ensureForAuthUser(authUserId: string): Promise<AccountSubject>;
  getActiveByAuthUserId(authUserId: string): Promise<AccountSubject | null>;
  beginDeletion(subjectId: string): Promise<AccountSubject>;
  detachAuthIdentity(subjectId: string, authUserId: string | null): Promise<AccountSubject>;
  completeDeletion(subjectId: string): Promise<AccountSubject>;
}
