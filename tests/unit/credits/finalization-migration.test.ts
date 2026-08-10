import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

it("keeps the finalization lease token migration, snapshot, and verifier aligned", () => {
  const migration = readFileSync("drizzle/0010_credit_finalization_lease_token.sql", "utf8");
  const snapshot = JSON.parse(readFileSync("drizzle/meta/0010_snapshot.json", "utf8")) as {
    tables: Record<
      string,
      { columns: Record<string, { name: string; type: string; notNull: boolean }> }
    >;
  };
  const verifier = readFileSync("scripts/verify-migrations.ts", "utf8");

  expect(migration).toContain(
    'ALTER TABLE "credit_finalization_jobs" ADD COLUMN "lease_token" text',
  );
  expect(snapshot.tables["public.credit_finalization_jobs"]?.columns.lease_token).toMatchObject({
    name: "lease_token",
    type: "text",
    notNull: false,
  });
  expect(verifier).toContain("table_name = 'credit_finalization_jobs'");
  expect(verifier).toContain("column_name = 'lease_token'");
  expect(verifier).toContain("credit_finalization_jobs.lease_token is missing");
});
