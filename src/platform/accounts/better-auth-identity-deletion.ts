import { randomBytes, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { session, user } from "@/platform/database/schema";

const WORKER_SESSION_AGENT = "creat-web-account-deletion-worker";
const WORKER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IdentityDeletion {
  prepareForDeletion?(authUserId: string): Promise<void>;
  deleteUser(authUserId: string): Promise<void>;
}

export function createBetterAuthIdentityDeletion(input: {
  readonly database: DatabaseClient;
  readonly invokeDeleteUser: (headers: Headers) => Promise<Response>;
  readonly now?: () => Date;
}): IdentityDeletion {
  const now = input.now ?? (() => new Date());

  return {
    async prepareForDeletion(authUserId) {
      const existing = await input.database
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, authUserId))
        .limit(1);
      if (!existing[0]) return;

      const preparedAt = now();
      const workerToken = randomBytes(32).toString("base64url");
      await input.database.transaction(async (transaction) => {
        await transaction.delete(session).where(eq(session.userId, authUserId));
        await transaction.insert(session).values({
          id: randomUUID(),
          token: workerToken,
          userId: authUserId,
          expiresAt: new Date(preparedAt.getTime() + WORKER_SESSION_TTL_MS),
          createdAt: preparedAt,
          updatedAt: preparedAt,
          userAgent: WORKER_SESSION_AGENT,
          ipAddress: null,
        });
      });
    },

    async deleteUser(authUserId) {
      const existing = await input.database
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, authUserId))
        .limit(1);
      if (!existing[0]) return;

      const refreshedAt = now();
      const refreshed = await input.database
        .update(session)
        .set({
          createdAt: refreshedAt,
          updatedAt: refreshedAt,
          expiresAt: new Date(refreshedAt.getTime() + WORKER_SESSION_TTL_MS),
        })
        .where(and(eq(session.userId, authUserId), eq(session.userAgent, WORKER_SESSION_AGENT)))
        .returning({ token: session.token });
      const workerSession = refreshed[0];
      if (!workerSession) {
        throw new Error("account deletion worker credential is unavailable");
      }

      const response = await input.invokeDeleteUser(
        new Headers({ authorization: `Bearer ${workerSession.token}` }),
      );
      if (!response.ok) {
        throw new Error(`Better Auth user deletion failed with status ${response.status}`);
      }

      const remaining = await input.database
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, authUserId))
        .limit(1);
      if (remaining[0]) throw new Error("Better Auth user deletion did not remove identity");
    },
  };
}
