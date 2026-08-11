import { eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { accountSubjects, type AccountSubjectRow } from "@/platform/database/schema";

export type AccountSubjectFenceTransaction = Parameters<
  Parameters<DatabaseClient["transaction"]>[0]
>[0];

export async function lockAccountSubject(
  transaction: AccountSubjectFenceTransaction,
  subjectId: string,
): Promise<AccountSubjectRow> {
  const [subject] = await transaction
    .select()
    .from(accountSubjects)
    .where(eq(accountSubjects.id, subjectId))
    .limit(1)
    .for("update");
  if (!subject) throw new Error("account subject not found");
  return subject;
}

export function requireActiveAccountSubject(subject: { readonly status: string }): void {
  if (subject.status !== "active") throw new Error("account subject is not active");
}
