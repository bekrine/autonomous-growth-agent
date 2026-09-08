import postgres from "postgres";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://agent:agent@localhost:5432/agent_growth";

/** Shared by every repository integration test so they all skip consistently without a live DB. */
export async function isDatabaseReachable(): Promise<boolean> {
  const sql = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 2 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}
