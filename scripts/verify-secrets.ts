import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { findPotentialSecrets } from "@/platform/security/secret-scan";

const SCAN_ROOTS = ["src", "scripts", ".github"] as const;
const ROOT_FILES = [
  ".env.example",
  "drizzle.config.ts",
  "eslint.config.mjs",
  "next.config.ts",
  "package.json",
  "playwright.config.ts",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.contract.config.ts",
  "vitest.integration.config.ts",
] as const;

const EXCLUDED_FILES = new Set([
  "src/platform/security/secret-scan.ts",
  "scripts/verify-secrets.ts",
]);

const TEXT_EXTENSION = /\.(?:ts|tsx|js|mjs|cjs|json|yml|yaml|env|example)$/;

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(target)));
      continue;
    }

    if (TEXT_EXTENSION.test(entry.name) || entry.name.startsWith(".env")) {
      files.push(target);
    }
  }

  return files;
}

const candidates = [
  ...ROOT_FILES,
  ...(await Promise.all(SCAN_ROOTS.map((root) => collectFiles(root)))).flat(),
];

const findings = [];
for (const file of [...new Set(candidates)].sort()) {
  if (EXCLUDED_FILES.has(file)) continue;
  const content = await readFile(file, "utf8");
  findings.push(...findPotentialSecrets(file, content));
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.kind}`);
  }
  throw new Error(`secret verification failed with ${findings.length} finding(s)`);
}

console.log(JSON.stringify({ event: "repository_secrets_verified", files: candidates.length }));
