import { spawnSync } from "node:child_process";
import { access, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Journal = {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly {
    readonly idx: number;
    readonly version: string;
    readonly tag: string;
  }[];
};

type Snapshot = {
  readonly id: string;
  readonly prevId: string;
  readonly version: string;
  readonly dialect: string;
  readonly tables: unknown;
  readonly enums: unknown;
  readonly schemas: unknown;
  readonly sequences: unknown;
  readonly roles: unknown;
  readonly policies: unknown;
  readonly views: unknown;
  readonly _meta: unknown;
};

const INITIAL_SNAPSHOT_ID = "00000000-0000-0000-0000-000000000000";
const DRIZZLE_KIT_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/drizzle-kit/bin.cjs",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function generatedArtifactNames(migrationsDirectory: string): Promise<readonly string[]> {
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => `migration:${name}`);
  const snapshots = (await readdir(path.join(migrationsDirectory, "meta")))
    .filter((name) => name.endsWith("_snapshot.json"))
    .map((name) => `snapshot:${name}`);
  return [...migrations, ...snapshots].sort();
}

export async function verifyMigrationMetadata(input: {
  readonly migrationsDirectory: string;
  readonly schemaPath: string;
}): Promise<void> {
  const metadataDirectory = path.join(input.migrationsDirectory, "meta");
  const journal = await readJson<Journal>(path.join(metadataDirectory, "_journal.json"));
  if (!journal.version || !journal.dialect || !Array.isArray(journal.entries)) {
    throw new Error("invalid migration journal metadata");
  }

  let expectedPreviousId = INITIAL_SNAPSHOT_ID;
  const snapshotIds = new Set<string>();
  for (const [position, entry] of journal.entries.entries()) {
    if (entry.idx !== position || entry.version !== journal.version || !entry.tag) {
      throw new Error(`invalid migration journal entry ${position}`);
    }
    await access(path.join(input.migrationsDirectory, `${entry.tag}.sql`));
    const snapshotNumber = String(entry.idx).padStart(4, "0");
    const snapshotPath = path.join(metadataDirectory, `${snapshotNumber}_snapshot.json`);
    let snapshot: Snapshot;
    try {
      snapshot = await readJson<Snapshot>(snapshotPath);
    } catch (error) {
      throw new Error(`missing snapshot for migration ${snapshotNumber}`, { cause: error });
    }
    if (
      !snapshot.id ||
      snapshotIds.has(snapshot.id) ||
      snapshot.prevId !== expectedPreviousId ||
      snapshot.version !== entry.version ||
      snapshot.dialect !== journal.dialect
    ) {
      throw new Error(`invalid snapshot chain at migration ${snapshotNumber}`);
    }
    for (const field of [
      "tables",
      "enums",
      "schemas",
      "sequences",
      "roles",
      "policies",
      "views",
      "_meta",
    ] as const) {
      if (!isRecord(snapshot[field])) {
        throw new Error(`invalid snapshot schema metadata at migration ${snapshotNumber}`);
      }
    }
    snapshotIds.add(snapshot.id);
    expectedPreviousId = snapshot.id;
  }

  await access(input.schemaPath);
  const probeRoot = await mkdtemp(path.join(tmpdir(), "creat-web-migration-drift-"));
  const probeMigrations = path.join(probeRoot, "drizzle");
  const probeConfig = path.join(probeRoot, "drizzle.config.ts");
  try {
    await cp(input.migrationsDirectory, probeMigrations, { recursive: true });
    const journalPath = path.join(probeMigrations, "meta", "_journal.json");
    const journalBefore = await readFile(journalPath, "utf8");
    const artifactsBefore = await generatedArtifactNames(probeMigrations);
    await writeFile(
      probeConfig,
      `export default {
  dialect: "postgresql",
  schema: ${JSON.stringify(path.resolve(input.schemaPath))},
  out: "./drizzle",
  dbCredentials: { url: "postgresql://metadata-verifier@127.0.0.1/metadata-verifier" },
  strict: true,
};
`,
      "utf8",
    );
    const generated = spawnSync(
      process.execPath,
      [DRIZZLE_KIT_CLI, "generate", "--config", probeConfig, "--name", "metadata_probe"],
      {
        cwd: probeRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://metadata-verifier@127.0.0.1/metadata-verifier",
        },
        timeout: 30_000,
      },
    );
    const journalAfter = await readFile(journalPath, "utf8");
    const artifactsAfter = await generatedArtifactNames(probeMigrations);
    const output = [generated.stdout, generated.stderr].filter(Boolean).join("\n").trim();
    if (
      journalAfter !== journalBefore ||
      JSON.stringify(artifactsAfter) !== JSON.stringify(artifactsBefore)
    ) {
      throw new Error("migration snapshot schema drift detected");
    }
    if (
      generated.error ||
      generated.status !== 0 ||
      !String(generated.stdout).includes("No schema changes, nothing to migrate")
    ) {
      throw new Error(`migration schema drift probe failed${output ? `: ${output}` : ""}`, {
        cause: generated.error,
      });
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}
