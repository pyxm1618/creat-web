import { spawnSync } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";

import { findPotentialSecrets } from "@/platform/security/secret-scan";

const ALLOWED_FAKE_VALUES_BY_FILE: Readonly<Record<string, readonly string[]>> = {
  ".github/workflows/ci.yml": [
    "schema-generation-secret-with-at-least-32-characters",
    "e2e-better-auth-secret-with-at-least-32-characters",
  ],
  "docs/superpowers/plans/2026-08-06-creat-web-authentication-plan.md": [
    "schema-generation-secret-with-at-least-32-characters",
  ],
  "scripts/verify-clean-setup.ts": [
    "clean-setup-auth-secret-with-more-than-32-characters",
    "clean-setup-google-client-secret-value",
    "clean-setup-test-private-key",
  ],
  "scripts/verify-release.ts": ["re_release_fixture"],
  "src/platform/config/load-runtime-config.ts": [
    "test-only-better-auth-secret-never-use-in-production",
  ],
  "tests/build/run-feature-matrix.ts": [
    "feature-matrix-auth-secret-with-at-least-32-characters",
    "feature-matrix-google-secret",
    "feature-matrix-private-key",
    "private-key",
  ],
  "tests/unit/config/commerce-runtime-env.test.ts": ["private-test-key"],
  "tests/unit/config/runtime-env.test.ts": ["re_test_not_a_live_key", "replace-me"],
  "tests/unit/observability/redact.test.ts": ["sk-secret"],
};
const rootArgument = process.argv.find((argument) => argument.startsWith("--root="))?.slice(7);
const repositoryRoot = path.resolve(rootArgument || ".");

function trackedFiles(root: string): string[] {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z"]);
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

function decodeText(content: Uint8Array): string | undefined {
  if (content.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

const findings = [];
let textFiles = 0;
let binaryFiles = 0;
const candidates = trackedFiles(repositoryRoot);
for (const file of candidates) {
  const target = path.join(repositoryRoot, file);
  const fileStat = await lstat(target);
  const bytes = fileStat.isSymbolicLink()
    ? new TextEncoder().encode(await readlink(target))
    : await readFile(target);
  const content = decodeText(bytes);
  if (content === undefined) {
    binaryFiles += 1;
    continue;
  }
  textFiles += 1;
  findings.push(
    ...findPotentialSecrets(file, content, {
      allowedAssignmentValues: ALLOWED_FAKE_VALUES_BY_FILE[file] ?? [],
    }),
  );
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.kind}`);
  }
  throw new Error(`secret verification failed with ${findings.length} finding(s)`);
}

console.log(
  JSON.stringify({
    event: "repository_secrets_verified",
    trackedFiles: candidates.length,
    textFiles,
    binaryFiles,
  }),
);
