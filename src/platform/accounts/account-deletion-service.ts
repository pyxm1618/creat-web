import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import {
  accountDeletionRequests,
  authSecurityEvents,
  type AccountDeletionRequestRow,
} from "@/platform/database/schema";

import type { AccountSubjectRepository } from "./account-subject-repository";
import type { IdentityDeletion } from "./better-auth-identity-deletion";

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 12;

export interface AccountDeletionCoordinator {
  prepare(input: { readonly subjectId: string; readonly operationKey: string }): Promise<void>;
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

function nextBackoff(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 8);
  return Math.min(30_000 * 2 ** exponent, 6 * 60 * 60 * 1000);
}

function duePredicate(now: Date) {
  return and(
    or(
      inArray(accountDeletionRequests.status, ["pending", "failed"]),
      and(
        eq(accountDeletionRequests.status, "processing"),
        or(
          isNull(accountDeletionRequests.leaseExpiresAt),
          lte(accountDeletionRequests.leaseExpiresAt, now),
        ),
      ),
    ),
    or(
      isNull(accountDeletionRequests.nextAttemptAt),
      lte(accountDeletionRequests.nextAttemptAt, now),
    ),
  );
}

export function createAccountDeletionService(input: {
  readonly database: DatabaseClient;
  readonly subjects: AccountSubjectRepository;
  readonly coordinator: AccountDeletionCoordinator;
  readonly identityDeletion: IdentityDeletion;
  readonly leaseMs?: number;
  readonly now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;

  async function claim(requestId: string): Promise<AccountDeletionRequestRow | null> {
    const claimedAt = now();
    const leaseToken = randomUUID();
    const rows = await input.database
      .update(accountDeletionRequests)
      .set({
        status: "processing",
        attempts: sql`${accountDeletionRequests.attempts} + 1`,
        lastErrorCode: null,
        leaseToken,
        leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs),
        nextAttemptAt: null,
        lastAttemptAt: claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(accountDeletionRequests.id, requestId), duePredicate(claimedAt)))
      .returning();
    return rows[0] ?? null;
  }

  async function advance(
    requestId: string,
    leaseToken: string,
    step: AccountDeletionRequestRow["step"],
  ): Promise<AccountDeletionRequestRow> {
    const rows = await input.database
      .update(accountDeletionRequests)
      .set({ step, lastErrorCode: null, updatedAt: now() })
      .where(
        and(
          eq(accountDeletionRequests.id, requestId),
          eq(accountDeletionRequests.status, "processing"),
          eq(accountDeletionRequests.leaseToken, leaseToken),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) throw new Error("account deletion lease lost");
    return row;
  }

  async function failClaim(current: AccountDeletionRequestRow, leaseToken: string): Promise<void> {
    const failedAt = now();
    const deadLetter = current.attempts >= MAX_ATTEMPTS;
    await input.database.transaction(async (tx) => {
      const [updated] = await tx
        .update(accountDeletionRequests)
        .set({
          status: deadLetter ? "dead_letter" : "failed",
          lastErrorCode: "deletion_step_failed",
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: deadLetter
            ? null
            : new Date(failedAt.getTime() + nextBackoff(current.attempts)),
          updatedAt: failedAt,
        })
        .where(
          and(
            eq(accountDeletionRequests.id, current.id),
            eq(accountDeletionRequests.status, "processing"),
            eq(accountDeletionRequests.leaseToken, leaseToken),
          ),
        )
        .returning({ id: accountDeletionRequests.id });

      if (updated && deadLetter) {
        await tx.insert(authSecurityEvents).values({
          eventType: "dead_letter_created",
          outcome: "failure",
          details: { queue: "account_deletion" },
        });
      }
    });
  }

  async function runClaimed(
    current: AccountDeletionRequestRow,
  ): Promise<AccountDeletionRequestRow> {
    const leaseToken = current.leaseToken;
    if (!leaseToken) throw new Error("account deletion claim has no lease token");

    try {
      if (current.step === "requested") {
        if (!current.authUserId) throw new Error("deletion identity is unavailable");
        await input.subjects.beginDeletion(current.subjectId);
        await input.identityDeletion.prepareForDeletion?.(current.authUserId);
        current = await advance(current.id, leaseToken, "access_revoked");
      }

      if (current.step === "access_revoked") {
        await input.coordinator.prepare({
          subjectId: current.subjectId,
          operationKey: current.id,
        });
        current = await advance(current.id, leaseToken, "downstream_prepared");
      }

      if (current.step === "downstream_prepared") {
        if (!current.authUserId) throw new Error("deletion identity is unavailable");
        await input.subjects.detachAuthIdentity(current.subjectId, current.authUserId);
        current = await advance(current.id, leaseToken, "identity_detached");
      }

      if (current.step === "identity_detached") {
        if (current.authUserId) {
          await input.identityDeletion.deleteUser(current.authUserId);
        }
        current = await advance(current.id, leaseToken, "identity_deleted");
      }

      if (current.step === "identity_deleted") {
        await input.subjects.completeDeletion(current.subjectId);
        const completedAt = now();
        const completedRows = await input.database
          .update(accountDeletionRequests)
          .set({
            authUserId: null,
            status: "completed",
            step: "completed",
            lastErrorCode: null,
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            updatedAt: completedAt,
            completedAt,
          })
          .where(
            and(
              eq(accountDeletionRequests.id, current.id),
              eq(accountDeletionRequests.status, "processing"),
              eq(accountDeletionRequests.leaseToken, leaseToken),
            ),
          )
          .returning();
        const completed = completedRows[0];
        if (!completed) throw new Error("account deletion completion lost its lease");
        current = completed;

        await input.database.insert(authSecurityEvents).values({
          subjectId: current.subjectId,
          eventType: "account_deleted",
          outcome: "success",
          details: {},
        });
      }

      return current;
    } catch (error) {
      await failClaim(current, leaseToken);
      throw new Error("account deletion failed", { cause: error });
    }
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
      const claimed = await claim(requestId);
      if (!claimed) return requireRequest(input.database, requestId);
      return runClaimed(claimed);
    },

    async runDueBatch(limit = 10): Promise<{
      readonly claimed: number;
      readonly completed: number;
      readonly failed: number;
    }> {
      const batchStartedAt = now();
      const candidates = await input.database
        .select({ id: accountDeletionRequests.id })
        .from(accountDeletionRequests)
        .where(duePredicate(batchStartedAt))
        .orderBy(asc(accountDeletionRequests.createdAt))
        .limit(Math.max(limit * 3, limit));

      let claimed = 0;
      let completed = 0;
      let failed = 0;
      for (const candidate of candidates) {
        if (claimed >= limit) break;
        const row = await claim(candidate.id);
        if (!row) continue;
        claimed += 1;
        try {
          const result = await runClaimed(row);
          if (result.status === "completed") completed += 1;
        } catch {
          failed += 1;
        }
      }

      return { claimed, completed, failed };
    },
  } as const;
}
