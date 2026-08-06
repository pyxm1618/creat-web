import { and, eq, inArray } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { accountSubjects, type AccountSubjectRow } from "@/platform/database/schema";

import type { AccountSubject } from "./account-subject";
import type { AccountSubjectRepository } from "./account-subject-repository";

function mapSubject(row: AccountSubjectRow): AccountSubject {
  return {
    id: row.id,
    authUserId: row.authUserId,
    status: row.status,
    pseudonymousKey: row.pseudonymousKey,
    createdAt: row.createdAt,
    deletionRequestedAt: row.deletionRequestedAt,
    deletedAt: row.deletedAt,
  };
}

async function requireSubject(rows: AccountSubjectRow[], message: string): Promise<AccountSubject> {
  const row = rows[0];
  if (!row) throw new Error(message);
  return mapSubject(row);
}

export function createPostgresAccountSubjectRepository(
  database: DatabaseClient,
): AccountSubjectRepository {
  return {
    async ensureForAuthUser(authUserId) {
      await database
        .insert(accountSubjects)
        .values({ authUserId })
        .onConflictDoNothing({ target: accountSubjects.authUserId });

      const rows = await database
        .select()
        .from(accountSubjects)
        .where(
          and(
            eq(accountSubjects.authUserId, authUserId),
            inArray(accountSubjects.status, ["active", "deletion_pending"]),
          ),
        )
        .limit(1);
      return requireSubject(rows, "account subject provisioning failed");
    },

    async getActiveByAuthUserId(authUserId) {
      const rows = await database
        .select()
        .from(accountSubjects)
        .where(
          and(eq(accountSubjects.authUserId, authUserId), eq(accountSubjects.status, "active")),
        )
        .limit(1);
      return rows[0] ? mapSubject(rows[0]) : null;
    },

    async beginDeletion(subjectId) {
      const rows = await database
        .update(accountSubjects)
        .set({ status: "deletion_pending", deletionRequestedAt: new Date() })
        .where(
          and(
            eq(accountSubjects.id, subjectId),
            inArray(accountSubjects.status, ["active", "deletion_pending"]),
          ),
        )
        .returning();
      return requireSubject(rows, "account subject cannot begin deletion");
    },

    async detachAuthIdentity(subjectId, authUserId) {
      const rows = await database
        .update(accountSubjects)
        .set({ authUserId: null })
        .where(
          and(
            eq(accountSubjects.id, subjectId),
            eq(accountSubjects.authUserId, authUserId),
            eq(accountSubjects.status, "deletion_pending"),
          ),
        )
        .returning();
      return requireSubject(rows, "account subject identity detach failed");
    },

    async completeDeletion(subjectId) {
      const rows = await database
        .update(accountSubjects)
        .set({ status: "deleted", deletedAt: new Date() })
        .where(
          and(
            eq(accountSubjects.id, subjectId),
            eq(accountSubjects.status, "deletion_pending"),
          ),
        )
        .returning();

      if (rows[0]) return mapSubject(rows[0]);
      const existing = await database
        .select()
        .from(accountSubjects)
        .where(and(eq(accountSubjects.id, subjectId), eq(accountSubjects.status, "deleted")))
        .limit(1);
      return requireSubject(existing, "account subject deletion completion failed");
    },
  };
}
