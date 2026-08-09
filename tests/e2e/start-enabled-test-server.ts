import { readFile, writeFile } from "node:fs/promises";

const featureConfigPath = "src/config/features.config.ts";
const original = await readFile(featureConfigPath, "utf8");
const enabledProfile = `import type { ProductConfig } from "@/platform/config/types";

export const featuresConfig = {
  auth: { enabled: true, google: false, magicLink: true, password: false },
  email: { enabled: true },
  commerce: { enabled: false, oneTime: false, subscriptions: false, credits: false },
  analytics: { enabled: true, ga4: true, clarity: true, consentRequired: true },
} as const satisfies ProductConfig["features"];
`;

let restored = false;
async function restore(): Promise<void> {
  if (restored) return;
  restored = true;
  await writeFile(featureConfigPath, original, "utf8");
}

await writeFile(featureConfigPath, enabledProfile, "utf8");
const child = Bun.spawn(["bun", "run", "dev"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal);
    void restore().finally(() => process.exit(0));
  });
}

const exitCode = await child.exited;
await restore();
process.exit(exitCode);
