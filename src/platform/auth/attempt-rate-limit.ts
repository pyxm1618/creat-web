import { createHmac } from "node:crypto";

import { sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";

export type AuthAttemptInput = {
  readonly scope: string;
  readonly identifiers: readonly string[];
  readonly windowMs: number;
  readonly max: number;
  readonly now: Date;
};

function counterKey(secret: string, scope: string, identifier: string): string {
  return createHmac("sha256", secret)
    .update("creat-web:auth-attempt:v1\0")
    .update(scope)
    .update("\0")
    .update(identifier)
    .digest("hex");
}

export function createAuthAttemptLimiter(database: DatabaseClient, secret: string) {
  if (secret.length < 32) throw new Error("auth attempt limiter secret is too short");

  return {
    async consume(input: AuthAttemptInput): Promise<void> {
      if (input.max < 1 || input.windowMs < 1 || input.identifiers.length === 0) {
        throw new Error("invalid authentication rate-limit policy");
      }

      const nowMs = input.now.getTime();
      const windowStart = nowMs - input.windowMs;
      const uniqueKeys = [
        ...new Set(input.identifiers.map((value) => counterKey(secret, input.scope, value))),
      ].sort();

      await database.transaction(async (transaction) => {
        for (const key of uniqueKeys) {
          const rows = await transaction.execute(sql<{ count: number }>`
            insert into "rate_limit" ("id", "key", "count", "last_request")
            values (${key}, ${key}, 1, ${nowMs})
            on conflict ("key") do update set
              "count" = case
                when "rate_limit"."last_request" < ${windowStart} then 1
                else "rate_limit"."count" + 1
              end,
              "last_request" = ${nowMs}
            returning "count"
          `);

          if ((rows[0]?.count ?? input.max + 1) > input.max) {
            throw new Error("authentication attempt rate limited");
          }
        }
      });
    },
  } as const;
}
