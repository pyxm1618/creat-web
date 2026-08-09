import { sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";

type CreditTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

function lockKey(subjectId: string, creditType: string): string {
  if (!subjectId.trim() || !creditType.trim()) throw new Error("credit mutation lock scope is required");
  return `${subjectId}:${creditType}`;
}

export async function withCreditMutationLock<T>({
  tx,
  subjectId,
  creditType,
  run,
}: Readonly<{
  tx: CreditTransaction;
  subjectId: string;
  creditType: string;
  run: () => Promise<T>;
}>): Promise<T> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(subjectId, creditType)}, 0))`);
  return run();
}

export async function tryCreditMutationLock({
  tx,
  subjectId,
  creditType,
}: Readonly<{
  tx: CreditTransaction;
  subjectId: string;
  creditType: string;
}>): Promise<boolean> {
  const result = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${lockKey(subjectId, creditType)}, 0)) as locked`,
  );
  return Boolean(result[0]?.locked);
}
