import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Union of the top-level Database client and the transaction-scoped client
 * passed into `db.transaction(async (tx) => ...)`. Repositories accept
 * this type instead of `Database` so the same repository class can be
 * constructed against either — required for the "N writes commit together
 * or none do" transactions used by multi-table persistence (e.g. a
 * strategy version + its agent_decision + agent_action row).
 */
export type DrizzleClient = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

let sql: postgres.Sql | undefined;
let db: Database | undefined;

/**
 * Creates (and memoizes) the singleton Postgres connection + Drizzle
 * client for this process. Postgres is the single source of truth for all
 * persistent business data — Redis/BullMQ are for transient job state only.
 */
export function createDatabase(connectionString: string): Database {
  if (db) return db;
  sql = postgres(connectionString, { max: 10 });
  db = drizzle(sql, { schema });
  return db;
}

export async function closeDatabase(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = undefined;
  db = undefined;
}
