import { sql } from "drizzle-orm";

import type { DatabaseClient } from "@/platform/database/client";

export type ReadinessResult =
  | { readonly status: "ready" }
  | { readonly status: "degraded"; readonly code: "dependency_unavailable" };

export async function checkReadiness(database: DatabaseClient): Promise<ReadinessResult> {
  try {
    await database.transaction(async (tx) => {
      await tx.execute(sql.raw("set local statement_timeout = '1500ms'"));
      await tx.execute(sql`select 1`);
      await tx.execute(sql.raw("select 1 from drizzle.__drizzle_migrations limit 1"));
    });
    return { status: "ready" };
  } catch {
    return { status: "degraded", code: "dependency_unavailable" };
  }
}
