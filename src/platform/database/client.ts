import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export function createDatabaseClient(url: string) {
  const client = postgres(url, {
    max: 5,
    prepare: false,
    connect_timeout: 10,
  });

  return {
    db: drizzle(client, { schema }),
    close: async () => client.end({ timeout: 5 }),
  };
}

export type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];
