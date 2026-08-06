import "server-only";

import { env } from "@/platform/config/env";

import { createDatabaseClient } from "./client";

const applicationDatabase = createDatabaseClient(env.databaseUrl);

export const db = applicationDatabase.db;
