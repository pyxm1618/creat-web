import { eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
  accountDeletionRequests,
  authSecurityEvents,
  session,
  user,
  type AccountDeletionRequestRow,
} from "@/platform/database/schema";

import type { AccountSubjectRepository } from "./account-subject-repository";

export interface AccountDeletionCoordinator {
  prepare(subjectId: string): Promise<void>;
}

export type AccountDeletionService = ReturnType<typeof createAccountDeletionService>;

async function requireRequest(
  database: DatabaseClient,
  requestId: string,
): Promise<AccountDeletionRequestRow> {
  const rows = await database
    .select()
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, requestId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("account deletion request not found");
  return row;
}

export function createAccountDeletionService(input: {
  readonly database: DatabaseClient;
  readonly subjects: AccountSubjectRepository;
  readonly coordinator: AccountDeletionCoordinator;
}) {
  async function advance(
    requestId: string,
    step: AccountDeletionRequestRow["step"],
  ): Promise<AccountDeletionRequestRow> {
    const rows = await input.database
      .update(accountDeletionRequests)
      .set({
        status: "processing",
        step,
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(eq(accountDeletionRequests.id, requestId))
      .returning();
    const row = rows[0];
    if (!row) throw new Error("account deletion request update failed");
    return row;
  }

  return {
    async request(request: {
      readonly subjectId: string;
      readonly authUserId: string;
    }): Promise<AccountDeletionRequestRow> {
      await input.database
        .insert(accountDeletionRequests)
        .values({
          subjectId: request.subjectId,
          authUserId: request.authUserId,
        })
        .onConflictDoNothing({ target: accountDeletionRequests.subjectId });

      const rows = await input.database
        .select()
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.subjectId, request.subjectId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("account deletion request creation failed");
      return row;
    },

    async run(requestId: string): Promise<AccountDeletionRequestRow> {
      let current = await requireRequest(input.database, requestId);
      if (current.status === "completed") return current;

      const claimed = await input.database
        .update(accountDeletionRequests)
        .set({
          status: "processing",
          attempts: current.attempts + 1,
          lastErrorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(accountDeletionRequests.id, requestId))
        .returning();
      current = claimed[0] ?? current;

      try {
        if (current.step === "requested") {
          await input.subjects.beginDeletion(current.subjectId);
          if (!current.authUserId) throw new Error("deletion identity is unavailable");
          await input.database.delete(session).where(eq(session.userId, current.authUserId));
          current = await advance(requestId, "access_revoked");
        }

        if (current.step === "access_revoked") {
          await input.coordinator.prepare(current.subjectId);
          current = await advance(requestId, "downstream_prepared");
        }

        if (current.step === "downstream_prepared") {
          if (!current.authUserId) throw new Error("deletion identity is unavailable");
          await input.subjects.detachAuthIdentity(current.subjectId, current.authUserId);
          current = await advance(requestId, "identity_detached");
        }

        if (current.step === "identity_detached") {
          if (current.authUserId) {
            await input.database.delete(user).where(eq(user.id, current.authUserId));
          }
          current = await advance(requestId, "identity_deleted");
        }

        if (current.step === "identity_deleted") {
          await input.subjects.completeDeletion(current.subjectId);
          const completedRows = await input.database
            .update(accountDeletionRequests)
            .set({
              authUserId: null,
              status: "completed",
              step: "completed",
              lastErrorCode: null,
              updatedAt: new Date(),
              completedAt: new Date(),
            })
            .where(eq(accountDeletionRequests.id, requestId))
            .returning();
          current = completedRows[0] ?? current;

          await input.database.insert(authSecurityEvents).values({
            subjectId: current.subjectId,
            eventType: "account_deleted",
            outcome: "success",
            details: {},
          });
        }

        return current;
      } catch (error) {
        await input.database
          .update(accountDeletionRequests)
          .set({
            status: "failed",
            lastErrorCode: "deletion_step_failed",
            updatedAt: new Date(),
          })
          .where(eq(accountDeletionRequests.id, requestId));

        throw new Error("account deletion failed", { cause: error });
      }
    },
  } as const;
}
