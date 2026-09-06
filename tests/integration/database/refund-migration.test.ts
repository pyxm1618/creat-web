import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDatabaseClient } from "@/platform/database/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const database = createDatabaseClient(databaseUrl);
const temporaryFolders = new Set<string>();

async function resetDatabase(): Promise<void> {
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS public CASCADE"));
  await database.db.execute(sql.raw("DROP SCHEMA IF EXISTS drizzle CASCADE"));
  await database.db.execute(sql.raw("CREATE SCHEMA public"));
}

async function migrationsThrough0012(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "creat-web-refund-migration-test-"));
  temporaryFolders.add(folder);
  const migrationsDirectory = path.join(folder, "drizzle");
  await cp(path.resolve("drizzle"), migrationsDirectory, { recursive: true });
  for (const migration of [
    "0013_exotic_iron_man",
    "0014_spooky_mandrill",
    "0015_refund_settlement_reference",
  ]) {
    await rm(path.join(migrationsDirectory, `${migration}.sql`));
    await rm(path.join(migrationsDirectory, "meta", `${migration.slice(0, 4)}_snapshot.json`));
  }

  const journalPath = path.join(migrationsDirectory, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: readonly unknown[];
  };
  await writeFile(
    journalPath,
    `${JSON.stringify({ ...journal, entries: journal.entries.slice(0, -3) }, null, 2)}\n`,
    "utf8",
  );
  return migrationsDirectory;
}

beforeAll(async () => {
  await resetDatabase();
  const migrationsDirectory = await migrationsThrough0012();
  await migrate(database.db, {
    migrationsFolder: migrationsDirectory,
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
});

afterAll(async () => {
  await Promise.all(
    [...temporaryFolders].map((folder) => rm(folder, { recursive: true, force: true })),
  );
  await database.close();
});

it("classifies legacy nonterminal refunds as unsafe without changing terminal validity", async () => {
  const subjectId = crypto.randomUUID();
  const productId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const refundIds = {
    pending: crypto.randomUUID(),
    processing: crypto.randomUUID(),
    succeeded: crypto.randomUUID(),
    failed: crypto.randomUUID(),
  };

  await database.db.execute(sql`
    insert into account_subjects (id) values (${subjectId})
  `);
  await database.db.execute(sql`
    insert into commerce_products (
      id, key, version, model, environment, provider_product_id, currency,
      expected_minor, fulfillment_key, refund_policy_key
    ) values (
      ${productId}, ${`migration-${crypto.randomUUID()}`}, 1, 'one_time', 'test',
      ${`PROD_${crypto.randomUUID()}`}, 'USD', 1000, 'migration-fulfillment', 'default'
    )
  `);
  await database.db.execute(sql`
    insert into orders (
      id, subject_id, product_id, environment, status, expected_currency,
      expected_minor, checkout_idempotency_key, checkout_state, external_order_id
    ) values (
      ${orderId}, ${subjectId}, ${productId}, 'test', 'paid', 'USD', 1000,
      ${`checkout:${crypto.randomUUID()}`}, 'created', ${`ORD_${crypto.randomUUID()}`}
    )
  `);
  await database.db.execute(sql`
    insert into payments (
      id, order_id, environment, external_payment_id, status, refund_status,
      currency, amount_minor, refunded_minor, raw_payload_hash
    ) values (
      ${paymentId}, ${orderId}, 'test', ${`PAY_${crypto.randomUUID()}`},
      'succeeded', 'none', 'USD', 1000, 0, ${"a".repeat(64)}
    )
  `);

  const refundsToInsert = [
    [refundIds.pending, "pending", "TKT_LEGACY_PENDING", "pending"],
    [refundIds.processing, "processing", "TKT_LEGACY_PROCESSING", "pending"],
    [refundIds.succeeded, "succeeded", "TKT_LEGACY_SUCCEEDED", "pending"],
    [refundIds.failed, "failed", "TKT_LEGACY_FAILED", "not_required"],
  ] as const;
  for (const [id, status, externalReference, reversalStatus] of refundsToInsert) {
    await database.db.execute(sql`
      insert into refunds (
        id, payment_id, subject_id, environment, external_refund_reference,
        idempotency_key, currency, requested_minor, succeeded_minor, reason,
        status, reversal_status
      ) values (
        ${id}, ${paymentId}, ${subjectId}, 'test', ${externalReference},
        ${`refund:${crypto.randomUUID()}`}, 'USD', 1000,
        ${status === "succeeded" ? 1000 : 0}, 'legacy migration fixture',
        ${status}, ${reversalStatus}
      )
    `);
  }

  await migrate(database.db, {
    migrationsFolder: path.resolve("drizzle"),
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });

  const migrated = await database.db.execute<{
    id: string;
    status: string;
    provider_write_state: string;
  }>(sql`
    select id, status, provider_write_state
    from refunds
    where id in (${sql.join(
      Object.values(refundIds).map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
  const byId = new Map(migrated.map((row) => [row.id, row]));

  expect(byId.get(refundIds.pending)).toMatchObject({
    status: "pending",
    provider_write_state: "legacy_unsafe",
  });
  expect(byId.get(refundIds.processing)).toMatchObject({
    status: "processing",
    provider_write_state: "legacy_unsafe",
  });
  expect(byId.get(refundIds.succeeded)).toMatchObject({
    status: "succeeded",
    provider_write_state: "confirmed",
  });
  expect(byId.get(refundIds.failed)).toMatchObject({
    status: "failed",
    provider_write_state: "confirmed",
  });
});
