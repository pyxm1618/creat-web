import { spawnSync } from "node:child_process";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");

const files = [
  "tests/integration/credits/expiry-boundary.test.ts",
  "tests/integration/credits/expiry-reservation-race.test.ts",
  "tests/integration/credits/credit-invariant.test.ts",
];

for (let iteration = 1; iteration <= 30; iteration += 1) {
  console.log(JSON.stringify({ event: "credit_race_iteration", iteration, total: 30 }));
  const result = spawnSync(
    "bunx",
    ["vitest", "run", "--config", "vitest.integration.config.ts", ...files],
    { stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) {
    throw new Error(`credit race verification failed on iteration ${iteration}`);
  }
}

console.log(JSON.stringify({ event: "credit_races_verified", iterations: 30 }));
