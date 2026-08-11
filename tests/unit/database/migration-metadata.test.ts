import { afterEach, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyMigrationMetadata } from "../../../scripts/verify-migration-metadata";

const temporaryFolders = new Set<string>();
const schemaPath = path.resolve("src/platform/database/schema.ts");

afterEach(async () => {
  await Promise.all(
    [...temporaryFolders].map((folder) => rm(folder, { recursive: true, force: true })),
  );
  temporaryFolders.clear();
});

async function migrationFixture(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "creat-web-migration-metadata-test-"));
  temporaryFolders.add(folder);
  const migrationsDirectory = path.join(folder, "drizzle");
  await cp(path.resolve("drizzle"), migrationsDirectory, { recursive: true });
  return migrationsDirectory;
}

it("rejects a journal entry whose snapshot is missing", async () => {
  const migrationsDirectory = await migrationFixture();
  await rm(path.join(migrationsDirectory, "meta", "0011_snapshot.json"));

  await expect(verifyMigrationMetadata({ migrationsDirectory, schemaPath })).rejects.toThrow(
    /missing snapshot.*0011/i,
  );
});

it("rejects a coherent snapshot chain that has drifted from the current schema", async () => {
  const migrationsDirectory = await migrationFixture();
  const snapshotPath = path.join(migrationsDirectory, "meta", "0011_snapshot.json");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
    tables: Record<string, unknown>;
  };
  delete snapshot.tables["public.payment_reconciliation_jobs"];
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  await expect(verifyMigrationMetadata({ migrationsDirectory, schemaPath })).rejects.toThrow(
    /schema drift/i,
  );
});

it("accepts the checked-in snapshot chain without creating repository artifacts", async () => {
  await expect(
    verifyMigrationMetadata({
      migrationsDirectory: path.resolve("drizzle"),
      schemaPath,
    }),
  ).resolves.toBeUndefined();
});
