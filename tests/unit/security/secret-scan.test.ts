import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findPotentialSecrets } from "@/platform/security/secret-scan";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((target) => rm(target, { force: true, recursive: true })),
  );
});

function runCommand(command: string, arguments_: string[], cwd = process.cwd()) {
  return spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

function runBun(arguments_: string[]) {
  return runCommand("bun", arguments_);
}

describe("findPotentialSecrets", () => {
  it("detects private keys and live-provider tokens", () => {
    const privateKey = ["-----BEGIN", " PRIVATE KEY-----"].join("");
    const liveToken = ["sk", "_live_", "abcdefghijklmnop"].join("");

    expect(findPotentialSecrets("config.ts", `${privateKey}\n${liveToken}`)).toEqual([
      expect.objectContaining({ kind: "private_key" }),
      expect.objectContaining({ kind: "live_provider_token" }),
    ]);
  });

  it("detects nonempty secret assignments", () => {
    const value = ["GOOGLE_CLIENT_SECRET", "=actual-secret-value"].join("");

    expect(findPotentialSecrets(".env.production", value)).toEqual([
      expect.objectContaining({ kind: "nonempty_secret_assignment" }),
    ]);
  });

  it("detects double-quoted, single-quoted, JSON, YAML, and TOML assignments", () => {
    const secret = ["review-fixture", "-secret-value"].join("");
    const content = [
      `CLIENT_SECRET="${secret}"`,
      `PRIVATE_KEY='${secret}'`,
      `const PROVIDER_API_KEY = "${secret}";`,
      `"API_KEY": "${secret}",`,
      `WEBHOOK_SECRET: '${secret}'`,
      `AUTH_SECRET = "${secret}"`,
    ].join("\n");

    expect(findPotentialSecrets("config", content)).toEqual([
      expect.objectContaining({ kind: "nonempty_secret_assignment", line: 1 }),
      expect.objectContaining({ kind: "nonempty_secret_assignment", line: 2 }),
      expect.objectContaining({ kind: "nonempty_secret_assignment", line: 3 }),
      expect.objectContaining({ kind: "nonempty_secret_assignment", line: 4 }),
      expect.objectContaining({ kind: "nonempty_secret_assignment", line: 5 }),
      expect.objectContaining({ kind: "nonempty_secret_assignment", line: 6 }),
    ]);
  });

  it("detects colon and equals assignments inside YAML sequence items", () => {
    const secret = ["yaml-sequence", "-secret-value"].join("");
    const content = [
      `- API_KEY: ${secret}`,
      `- AUTH_SECRET=${secret}`,
      `- "CLIENT_SECRET": "${secret}"`,
      `- PRIVATE_KEY='${secret}'`,
    ].join("\n");

    expect(findPotentialSecrets("config.yaml", content)).toEqual([
      expect.objectContaining({ kind: "nonempty_secret_assignment", line: 1 }),
      expect.objectContaining({ kind: "nonempty_secret_assignment", line: 2 }),
      expect.objectContaining({ kind: "nonempty_secret_assignment", line: 3 }),
      expect.objectContaining({ kind: "nonempty_secret_assignment", line: 4 }),
    ]);
  });

  it("allows documented empty placeholders", () => {
    expect(
      findPotentialSecrets(
        ".env.example",
        ["GOOGLE_CLIENT_SECRET=", "RESEND_API_KEY=", "WAFFO_PRIVATE_KEY="].join("\n"),
      ),
    ).toEqual([]);
  });

  it("allows only exact repository fixture values", () => {
    expect(
      findPotentialSecrets(
        "scripts/release-fixture.yaml",
        ['- RESEND_API_KEY: "re_release_fixture"', "- AUTH_SECRET='secret-scan-fixture'"].join(
          "\n",
        ),
        { allowedAssignmentValues: ["re_release_fixture", "secret-scan-fixture"] },
      ),
    ).toEqual([]);
    expect(
      findPotentialSecrets(
        "scripts/release-fixture.yaml",
        '- AUTH_SECRET: "secret-scan-fixture-x"',
        { allowedAssignmentValues: ["secret-scan-fixture"] },
      ),
    ).toEqual([expect.objectContaining({ kind: "nonempty_secret_assignment" })]);
  });
});

describe("repository secret verification", () => {
  async function createGitFixture(
    files: Readonly<Record<string, string | Uint8Array>>,
  ): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "creat-web-secret-repository-"));
    temporaryPaths.push(root);
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    expect(runCommand("git", ["init", "-q"], root).status).toBe(0);
    expect(runCommand("git", ["add", "--", ...Object.keys(files)], root).status).toBe(0);
    return root;
  }

  it("scans every tracked text source regardless of root name or extension", async () => {
    const secret = ["tracked-review", "-secret-value"].join("");
    const privateKey = ["-----BEGIN", " PRIVATE KEY-----"].join("");
    const files = {
      README: `ROOT_AUTH_SECRET='${secret}'`,
      ".config": `CLIENT_SECRET = "${secret}"`,
      "config.toml": `API_KEY = '${secret}'`,
      "notes.txt": `WEBHOOK_SECRET: "${secret}"`,
      "schema.graphql": `AUTH_SECRET: '${secret}'`,
      "bun.lock": `CLIENT_SECRET = "${secret}"`,
      "src/runtime-config": `API_KEY='${secret}'`,
      "tests/provider.pem": privateKey,
      "docs/provider.key": `PRIVATE_KEY = "${secret}"`,
      "public/provider.config": `WEBHOOK_SECRET = '${secret}'`,
    } as const;
    const root = await createGitFixture(files);

    const result = runBun(["scripts/verify-secrets.ts", `--root=${root}`]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    for (const file of Object.keys(files)) expect(output).toContain(file);
  });

  it("ignores untracked files even under a scanned source root", async () => {
    const root = await createGitFixture({ "src/tracked.ts": "export const safe = true;" });
    await writeFile(
      path.join(root, "src/untracked.ts"),
      ["API_KEY", "=untracked-secret-value"].join(""),
      "utf8",
    );

    const result = runBun(["scripts/verify-secrets.ts", `--root=${root}`]);

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("repository_secrets_verified");
  });

  it("does not decode a tracked binary file as source text", async () => {
    const secretText = new TextEncoder().encode(["API_KEY", "=binary-secret-value"].join(""));
    const binary = new Uint8Array(secretText.length + 1);
    binary.set(secretText);
    binary[binary.length - 1] = 0;
    const root = await createGitFixture({ "src/fixture.bin": binary });

    const result = runBun(["scripts/verify-secrets.ts", `--root=${root}`]);

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('"binaryFiles":1');
  });
});

describe("Credits release artifacts", () => {
  const artifactFiles = [
    "drizzle/0009_production_readiness.sql",
    "drizzle/0010_credit_finalization_lease_token.sql",
    "drizzle/meta/0009_snapshot.json",
    "drizzle/meta/0010_snapshot.json",
    "drizzle/meta/_journal.json",
  ] as const;

  async function createArtifactRoot() {
    const root = await mkdtemp(path.join(tmpdir(), "creat-web-release-artifacts-"));
    temporaryPaths.push(root);
    await mkdir(path.join(root, "drizzle"), { recursive: true });
    await mkdir(path.join(root, "drizzle/meta"), { recursive: true });
    for (const file of artifactFiles) {
      await copyFile(path.join(process.cwd(), file), path.join(root, file));
    }
    return root;
  }

  function runArtifactVerifier(root: string) {
    const expression = [
      'import { verifyCreditsReleaseArtifacts } from "./scripts/verify-release.ts";',
      `await verifyCreditsReleaseArtifacts(${JSON.stringify(root)});`,
    ].join("\n");
    return runBun(["-e", expression]);
  }

  async function mutateJson(
    root: string,
    file: string,
    mutation: (value: Record<string, unknown>) => void,
  ) {
    const target = path.join(root, file);
    const value = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    mutation(value);
    await writeFile(target, JSON.stringify(value), "utf8");
  }

  it("accepts complete durable Credits artifacts", async () => {
    const root = await createArtifactRoot();

    const result = runArtifactVerifier(root);

    expect(`${result.stdout}\n${result.stderr}`).toContain("credits_release_artifacts_verified");
    expect(result.status).toBe(0);
  });

  it("rejects a missing append-only integrity migration", async () => {
    const root = await createArtifactRoot();
    await rm(path.join(root, "drizzle/0009_production_readiness.sql"));

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "durable credit ledger integrity migration is missing",
    );
  });

  it("rejects a missing finalization lease-token migration", async () => {
    const root = await createArtifactRoot();
    await rm(path.join(root, "drizzle/0010_credit_finalization_lease_token.sql"));

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "credit finalization lease migration is missing",
    );
  });

  it("rejects durable Credits migrations omitted from the applied journal", async () => {
    const root = await createArtifactRoot();
    await mutateJson(root, "drizzle/meta/_journal.json", (journal) => {
      journal.entries = (journal.entries as Array<{ tag: string }>).filter(
        (entry) => entry.tag !== "0010_credit_finalization_lease_token",
      );
    });

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "durable Credits migrations are missing from the migration journal",
    );
  });

  it("rejects a migration journal truncated before the generated Credits chain", async () => {
    const root = await createArtifactRoot();
    await mutateJson(root, "drizzle/meta/_journal.json", (journal) => {
      journal.entries = (journal.entries as Array<Record<string, unknown>>)
        .filter(
          (entry) =>
            entry.tag === "0009_production_readiness" ||
            entry.tag === "0010_credit_finalization_lease_token",
        )
        .map((entry, idx) => ({ ...entry, idx }));
    });

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "durable Credits migrations are missing from the migration journal",
    );
  });

  it("rejects an incident snapshot without the durable reconciliation table", async () => {
    const root = await createArtifactRoot();
    await mutateJson(root, "drizzle/meta/0009_snapshot.json", (snapshot) => {
      delete (snapshot.tables as Record<string, unknown>)["public.credit_reconciliation_incidents"];
    });

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "credit reconciliation incident snapshot is incomplete",
    );
  });

  it("rejects an incident snapshot with the wrong stable identity index", async () => {
    const root = await createArtifactRoot();
    await mutateJson(root, "drizzle/meta/0009_snapshot.json", (snapshot) => {
      const tables = snapshot.tables as Record<
        string,
        { indexes: Record<string, { columns: Array<{ expression: string }> }> }
      >;
      const index =
        tables["public.credit_reconciliation_incidents"]?.indexes.credit_reconciliation_incident_uq;
      if (index) index.columns = [{ expression: "entity_id" }, { expression: "code" }];
    });

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "credit reconciliation incident snapshot is incomplete",
    );
  });

  it("rejects a finalization snapshot without the nullable lease token", async () => {
    const root = await createArtifactRoot();
    await mutateJson(root, "drizzle/meta/0010_snapshot.json", (snapshot) => {
      const tables = snapshot.tables as Record<string, { columns: Record<string, unknown> }>;
      delete tables["public.credit_finalization_jobs"]?.columns.lease_token;
    });

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "credit finalization lease snapshot is incomplete",
    );
  });

  it("rejects a lease token that was not introduced by migration 0010", async () => {
    const root = await createArtifactRoot();
    const leaseSnapshot = JSON.parse(
      await readFile(path.join(root, "drizzle/meta/0010_snapshot.json"), "utf8"),
    ) as {
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    await mutateJson(root, "drizzle/meta/0009_snapshot.json", (snapshot) => {
      const tables = snapshot.tables as Record<string, { columns: Record<string, unknown> }>;
      const leaseToken =
        leaseSnapshot.tables["public.credit_finalization_jobs"]?.columns.lease_token;
      if (leaseToken) {
        tables["public.credit_finalization_jobs"]!.columns.lease_token = leaseToken;
      }
    });

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "credit finalization lease snapshot is incomplete",
    );
  });

  it("rejects a broken generated snapshot chain", async () => {
    const root = await createArtifactRoot();
    await mutateJson(root, "drizzle/meta/0010_snapshot.json", (snapshot) => {
      snapshot.prevId = "00000000-0000-0000-0000-000000000000";
    });

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Credits migration snapshots are not contiguous",
    );
  });

  it("rejects migration signatures that exist only inside SQL comments", async () => {
    const root = await createArtifactRoot();
    const integrity = await readFile(
      path.join(root, "drizzle/0009_production_readiness.sql"),
      "utf8",
    );
    await writeFile(
      path.join(root, "drizzle/0009_production_readiness.sql"),
      integrity
        .split("\n")
        .map((line) => `-- ${line}`)
        .join("\n"),
      "utf8",
    );

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "durable credit ledger integrity migration is not executable",
    );
  });

  it("rejects ledger signatures hidden after a nested block comment closes", async () => {
    const root = await createArtifactRoot();
    await writeFile(
      path.join(root, "drizzle/0009_production_readiness.sql"),
      [
        "/* outer PostgreSQL block comment",
        "   /* nested block comment */",
        '   CREATE FUNCTION "reject_credit_ledger_mutation"() RETURNS trigger;',
        '   CREATE TRIGGER "credit_ledger_entries_append_only"',
        '   BEFORE UPDATE OR DELETE ON "credit_ledger_entries"',
        '   EXECUTE FUNCTION "reject_credit_ledger_mutation"();',
        "*/",
      ].join("\n"),
      "utf8",
    );

    const result = runArtifactVerifier(root);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "durable credit ledger integrity migration is not executable",
    );
  });

  it.each(["E", "e"])(
    "rejects ledger signatures hidden after escaped quotes in %s strings",
    async (escapePrefix) => {
      const root = await createArtifactRoot();
      await writeFile(
        path.join(root, "drizzle/0009_production_readiness.sql"),
        [
          String.raw`SELECT ${escapePrefix}'prefix\\path\' marker keywords`,
          'CREATE FUNCTION "reject_credit_ledger_mutation"() RETURNS trigger;',
          'CREATE TRIGGER "credit_ledger_entries_append_only"',
          'BEFORE UPDATE OR DELETE ON "credit_ledger_entries"',
          'EXECUTE FUNCTION "reject_credit_ledger_mutation"();',
          String.raw`multiple escapes \n \t \x41 \\ suffix';`,
        ].join("\n"),
        "utf8",
      );

      const result = runArtifactVerifier(root);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "durable credit ledger integrity migration is not executable",
      );
    },
  );

  it("keeps a real ledger function visible after escape and standard strings", async () => {
    const root = await createArtifactRoot();
    await writeFile(
      path.join(root, "drizzle/0009_production_readiness.sql"),
      [
        String.raw`SELECT E'escaped quote \' slash \\ newline \n tab \t done';`,
        String.raw`SELECT 'standard string trailing backslash\';`,
        'CREATE FUNCTION "reject_credit_ledger_mutation"() RETURNS trigger',
        "LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;",
        'CREATE TRIGGER "credit_ledger_entries_append_only"',
        'BEFORE UPDATE OR DELETE ON "credit_ledger_entries"',
        'FOR EACH ROW EXECUTE FUNCTION "reject_credit_ledger_mutation"();',
      ].join("\n"),
      "utf8",
    );

    const result = runArtifactVerifier(root);

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("credits_release_artifacts_verified");
  });

  it("accepts legal trigger event reordering and SQL reformatting", async () => {
    const root = await createArtifactRoot();
    const target = path.join(root, "drizzle/0009_production_readiness.sql");
    const integrity = await readFile(target, "utf8");
    await writeFile(
      target,
      integrity
        .replace("BEFORE UPDATE OR DELETE", "BEFORE\n  DELETE OR UPDATE")
        .replace(
          'CREATE TRIGGER "credit_ledger_entries_append_only"',
          'CREATE   TRIGGER\n"credit_ledger_entries_append_only"',
        ),
      "utf8",
    );

    const result = runArtifactVerifier(root);

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("credits_release_artifacts_verified");
  });
});
