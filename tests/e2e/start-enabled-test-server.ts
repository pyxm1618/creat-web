import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

let activeChild: ChildProcess | undefined;
const waffoTestKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const testEnv: NodeJS.ProcessEnv = {
  ...process.env,
  APP_ENV: "test",
  CREAT_WEB_E2E_ENABLED_FEATURES: "1",
  CREAT_WEB_E2E_COMMERCE: "1",
  WAFFO_MERCHANT_ID: "MER_2D5F8G3H1K4M6N9P0Q7R8S",
  WAFFO_PRIVATE_KEY: waffoTestKeys.privateKey,
  WAFFO_STORE_ID: "STO_2aUyqjCzEIiEcYMKj7TZtw",
  WAFFO_WEBHOOK_TEST_PUBLIC_KEY: waffoTestKeys.publicKey,
  COMMERCE_RETENTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  COMMERCE_RETENTION_KEY_ID: "e2e-key-v1",
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    activeChild?.kill(signal);
  });
}

const build = spawn("bun", ["run", "build:test"], {
  stdio: "inherit",
  env: testEnv,
});
activeChild = build;
const buildExitCode = await waitForExit(build);
if (buildExitCode !== 0) process.exitCode = buildExitCode;
else {
  const server = spawn("bun", ["run", "start"], {
    stdio: "inherit",
    env: testEnv,
  });
  activeChild = server;
  process.exitCode = await waitForExit(server);
}
