import { createDatabaseClient } from "@/platform/database/client";
import { inspectDeadLetters } from "@/platform/operations/dead-letters";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const environment = argument("environment");
const databaseUrl = process.env.DATABASE_URL;
if (!environment || !["local", "test", "staging", "production"].includes(environment)) {
  throw new Error("--environment=local|test|staging|production is required");
}
if (process.env.APP_ENV && process.env.APP_ENV !== environment) {
  throw new Error("--environment must match APP_ENV");
}
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const connection = createDatabaseClient(databaseUrl);
try {
  const rows = await inspectDeadLetters(connection.db);
  console.log(JSON.stringify({ environment, deadLetters: rows }, null, 2));
} finally {
  await connection.close();
}
