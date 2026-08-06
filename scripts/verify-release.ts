import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { featuresConfig } from "@/config/features.config";
import { siteConfig } from "@/config/site.config";
import { validateProductConfig } from "@/platform/config/validate-config";

validateProductConfig({ site: siteConfig, features: featuresConfig });

const forbidden = [/quick[ -]?i[ -]?ching/i, /ichingcoin/i, /hexagram/i, /casting/i];

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(target)));
    else if (/\.(?:ts|tsx|css|json)$/.test(entry.name)) files.push(target);
  }
  return files;
}

for (const file of await collectFiles("src")) {
  const content = await readFile(file, "utf8");
  const match = forbidden.find((pattern) => pattern.test(content));
  if (match) throw new Error(`product-specific content found in ${file}: ${match}`);
}

if (siteConfig.canonicalOrigin.includes("localhost")) {
  throw new Error("release site origin must not use localhost");
}

console.log(
  JSON.stringify({
    event: "foundation_release_verified",
    site: siteConfig.slug,
    externalProvidersEnabled: false,
  }),
);
