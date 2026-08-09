import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = join(ROOT, "examples", "neutral-product");
const TARGET = join(ROOT, "src", "config");
const FILES = [
  "site.config.ts",
  "features.config.ts",
  "products.config.ts",
  "seo.config.ts",
  "routes.config.ts",
  "legal.config.ts",
] as const;
const confirmed = process.argv.includes("--confirm");

for (const file of FILES) {
  const source = join(EXAMPLE, file);
  const target = join(TARGET, file);
  if (!existsSync(source) || !existsSync(target)) {
    throw new Error(`expected versioned config path is missing: ${file}`);
  }
  if (basename(source) !== basename(target) || !target.startsWith(`${TARGET}/`)) {
    throw new Error(`refusing unexpected config target: ${target}`);
  }

  const status = execFileSync("git", ["status", "--porcelain", "--", target], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (status && !confirmed) {
    throw new Error(`refusing to overwrite modified config without --confirm: ${file}`);
  }
}

for (const file of FILES) copyFileSync(join(EXAMPLE, file), join(TARGET, file));
console.log(JSON.stringify({ event: "neutral_example_applied", files: FILES.length }));
