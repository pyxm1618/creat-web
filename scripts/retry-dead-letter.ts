import { createDatabaseClient } from "@/platform/database/client";
import { retryDeadLetter, type DeadLetterQueue } from "@/platform/operations/dead-letters";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const environment = argument("environment");
const queue = argument("queue") as DeadLetterQueue | undefined;
const id = argument("id");
const reason = argument("reason");
const confirm = argument("confirm");
const databaseUrl = process.env.DATABASE_URL;
const environments = ["local", "test", "staging", "production"] as const;
const queues: readonly DeadLetterQueue[] = [
  "webhook",
  "fulfillment",
  "commerce_command",
  "credit_finalization",
  "account_deletion",
];

if (!environment || !environments.includes(environment as (typeof environments)[number])) {
  throw new Error("--environment=local|test|staging|production is required");
}
if (!queue || !queues.includes(queue)) {
  throw new Error(`--queue=${queues.join("|")} is required`);
}
if (!id) throw new Error("--id=<dead-letter-id> is required");
if (!reason) throw new Error("--reason=<operator-reason> is required");
if (confirm !== `RETRY:${id}`) {
  throw new Error(`--confirm=RETRY:${id} is required`);
}
if (process.env.APP_ENV && process.env.APP_ENV !== environment) {
  throw new Error("--environment must match APP_ENV");
}
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const connection = createDatabaseClient(databaseUrl);
try {
  const changed = await retryDeadLetter(connection.db, {
    queue,
    id,
    environment: environment as (typeof environments)[number],
    reason,
  });
  if (!changed) throw new Error("dead-letter record not found or no longer retryable");
  console.log(JSON.stringify({ event: "dead_letter_retry_accepted", queue, environment }));
} finally {
  await connection.close();
}
