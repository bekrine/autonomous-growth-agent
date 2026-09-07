import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadEnv } from "@agent/shared";
import { createDatabase, closeDatabase } from "./client.js";

async function main() {
  const env = loadEnv();
  const db = createDatabase(env.DATABASE_URL);
  await migrate(db, { migrationsFolder: "../../migrations" });
  await closeDatabase();
  // eslint-disable-next-line no-console
  console.log("Migrations applied successfully.");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Migration failed:", error);
  process.exit(1);
});
