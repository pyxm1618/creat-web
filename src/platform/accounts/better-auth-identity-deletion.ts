import { and, desc, eq, gt } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";
import { session, user } from "@/platform/database/schema";

export interface IdentityDeletion {
  deleteUser(authUserId: string): Promise<void>;
}

export function createBetterAuthIdentityDeletion(input: {
  readonly database: DatabaseClient;
  readonly invokeDeleteUser: (headers: Headers) => Promise<Response>;
  readonly now?: () => Date;
}): IdentityDeletion {
  const now = input.now ?? (() => new Date());

  return {
    async deleteUser(authUserId) {
      const existing = await input.database
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, authUserId))
        .limit(1);
      if (!existing[0]) return;

      const sessions = await input.database
        .select({ token: session.token })
        .from(session)
        .where(and(eq(session.userId, authUserId), gt(session.expiresAt, now())))
        .orderBy(desc(session.createdAt))
        .limit(1);
      const activeSession = sessions[0];
      if (!activeSession) {
        throw new Error("account deletion has no active Better Auth session");
      }

      const response = await input.invokeDeleteUser(
        new Headers({ authorization: `Bearer ${activeSession.token}` }),
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
