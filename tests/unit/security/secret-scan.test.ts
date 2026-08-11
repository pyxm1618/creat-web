import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function runBun(arguments_: string[]) {
  return spawnSync("bun", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
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

  it("allows documented empty placeholders", () => {
    expect(
      findPotentialSecrets(
        ".env.example",
        ["GOOGLE_CLIENT_SECRET=", "RESEND_API_KEY=", "WAFFO_PRIVATE_KEY="].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("repository secret verification", () => {
  it.each([
    ["tests", ".secret-scan-fixture.ts"],
    ["docs", ".secret-scan-fixture.md"],
    ["drizzle", ".secret-scan-fixture.sql"],
  ])("fails for a secret under %s", async (root, fileName) => {
    const fixture = path.join(process.cwd(), root, fileName);
    temporaryPaths.push(fixture);
    await writeFile(fixture, ["FIXTURE_API_KEY", "=fixture-secret-value"].join(""), "utf8");

    const result = runBun(["scripts/verify-secrets.ts"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(path.join(root, fileName));
  });
});

describe("Credits release artifacts", () => {
  async function createArtifactRoot(input: {
    readonly integrityMigration?: boolean;
    readonly leaseMigration?: boolean;
    readonly commerceCoordinator?: boolean;
    readonly journalEntries?: readonly string[];
  }) {
    const root = await mkdtemp(path.join(tmpdir(), "creat-web-release-artifacts-"));
    temporaryPaths.push(root);
    await mkdir(path.join(root, "drizzle"), { recursive: true });
    await mkdir(path.join(root, "drizzle/meta"), { recursive: true });
    await mkdir(path.join(root, "src/platform/accounts"), { recursive: true });
    if (input.integrityMigration) {
      await writeFile(
        path.join(root, "drizzle/0009_production_readiness.sql"),
        [
          'CREATE FUNCTION "reject_credit_ledger_mutation"() RETURNS trigger;',
          'CREATE TRIGGER "credit_ledger_entries_append_only"',
          'BEFORE UPDATE OR DELETE ON "credit_ledger_entries";',
        ].join("\n"),
        "utf8",
      );
    }
    if (input.leaseMigration) {
      await writeFile(
        path.join(root, "drizzle/0010_credit_finalization_lease_token.sql"),
        'ALTER TABLE "credit_finalization_jobs" ADD COLUMN "lease_token" text;',
        "utf8",
      );
    }
    if (input.commerceCoordinator) {
      await writeFile(
        path.join(root, "src/platform/accounts/platform-account-deletion-coordinator.ts"),
        [
          "const key = `account-delete:${operationKey}:${subscriptionId}`;",
          'throw new Error("commerce account deletion preparation pending");',
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(root, "src/platform/accounts/account-deletion-runtime.ts"),
        "createPlatformAccountDeletionCoordinator({ database: db, getCommerce: getCommerceRuntime });",
        "utf8",
      );
    }
    await writeFile(
      path.join(root, "drizzle/meta/_journal.json"),
      JSON.stringify({
        entries: (
          input.journalEntries ?? [
            "0009_production_readiness",
            "0010_credit_finalization_lease_token",
          ]
        ).map((tag) => ({ tag })),
      }),
      "utf8",
    );
    return root;
  }

  function runArtifactVerifier(root: string, commerceEnabled: boolean) {
    const expression = [
      'import { verifyCreditsReleaseArtifacts } from "./scripts/verify-release.ts";',
      `await verifyCreditsReleaseArtifacts(${JSON.stringify(root)}, { commerceEnabled: ${String(commerceEnabled)} });`,
    ].join("\n");
    return runBun(["-e", expression]);
  }

  it("accepts complete durable Credits artifacts", async () => {
    const root = await createArtifactRoot({
      integrityMigration: true,
      leaseMigration: true,
      commerceCoordinator: true,
    });

    const result = runArtifactVerifier(root, true);

    expect(`${result.stdout}\n${result.stderr}`).toContain("credits_release_artifacts_verified");
    expect(result.status).toBe(0);
  });

  it("rejects a missing append-only integrity migration", async () => {
    const root = await createArtifactRoot({ leaseMigration: true });

    const result = runArtifactVerifier(root, false);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "durable credit ledger integrity migration is missing",
    );
  });

  it("rejects a missing finalization lease-token migration", async () => {
    const root = await createArtifactRoot({ integrityMigration: true });

    const result = runArtifactVerifier(root, false);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "credit finalization lease migration is missing",
    );
  });

  it("rejects durable Credits migrations omitted from the applied journal", async () => {
    const root = await createArtifactRoot({
      integrityMigration: true,
      leaseMigration: true,
      journalEntries: ["0009_production_readiness"],
    });

    const result = runArtifactVerifier(root, false);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "durable Credits migrations are missing from the migration journal",
    );
  });

  it("rejects commerce without durable account-deletion coordination", async () => {
    const root = await createArtifactRoot({ integrityMigration: true, leaseMigration: true });

    const result = runArtifactVerifier(root, true);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "commerce account deletion coordinator is missing",
    );
  });
});
