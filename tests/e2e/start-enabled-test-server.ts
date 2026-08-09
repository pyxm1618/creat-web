import { spawn, type ChildProcess } from "node:child_process";

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

let activeChild: ChildProcess | undefined;
const testEnv: NodeJS.ProcessEnv = {
  ...process.env,
  APP_ENV: "test",
  CREAT_WEB_E2E_ENABLED_FEATURES: "1",
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
