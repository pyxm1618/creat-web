import { createDatabaseClient } from "@/platform/database/client";
import { verifyRestoredDatabase } from "@/platform/operations/restored-database";

const restoredDatabaseUrl = process.env.RESTORED_DATABASE_URL;
if (!restoredDatabaseUrl) throw new Error("RESTORED_DATABASE_URL is required");

const connection = createDatabaseClient(restoredDatabaseUrl);
try {
  const result = await verifyRestoredDatabase(connection.db);
  console.log(JSON.stringify({ event: "restored_database_verified", ...result }));
} finally {
  await connection.close();
}
