import { createDatabaseClient } from "@/platform/database/client";

import { createAuth } from "./create-auth";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for auth schema generation");

const database = createDatabaseClient(databaseUrl);

export const auth = createAuth({
  appName: "Creat Web Schema",
  baseURL: process.env.APP_ORIGIN ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET ?? "schema-generation-secret-with-at-least-32-characters",
  cookiePrefix: "creat-web-schema",
  database: database.db,
  sendMagicLink: async () => undefined,
});
