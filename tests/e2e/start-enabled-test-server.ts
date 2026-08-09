import { spawn, type ChildProcess } from "node:child_process";
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

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

let restored = false;
let server: ChildProcess | undefined;
async function restore(): Promise<void> {
  if (restored) return;
  restored = true;
  await writeFile(featureConfigPath, original, "utf8");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server?.kill(signal);
    void restore().finally(() => process.exit(0));
  });
}

try {
  await writeFile(featureConfigPath, enabledProfile, "utf8");
  const build = spawn("bun", ["run", "build:test"], {
    stdio: "inherit",
    env: process.env,
  });
  const buildExitCode = await waitForExit(build);
  if (buildExitCode !== 0) process.exitCode = buildExitCode;
  else {
    server = spawn("bun", ["run", "start"], {
      stdio: "inherit",
      env: process.env,
    });
    process.exitCode = await waitForExit(server);
  }
} finally {
  await restore();
}
