import { spawn, type ChildProcess } from "node:child_process";

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

const env = {
  ...process.env,
  APP_ENV: "production",
  APP_ORIGIN: "https://example.com",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://test:test@127.0.0.1:5432/test",
};

const build = spawn("bun", ["run", "build"], { stdio: "inherit", env });
const buildExitCode = await waitForExit(build);
if (buildExitCode !== 0) process.exit(buildExitCode);

const server = spawn("bun", ["run", "start", "--", "-p", "3100"], {
  stdio: "inherit",
  env,
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.kill(signal));
}
process.exitCode = await waitForExit(server);
