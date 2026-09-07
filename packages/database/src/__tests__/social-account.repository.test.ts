import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDatabase, createDatabase } from "../client.js";
import { SocialAccountRepository } from "../repositories/social-account.repository.js";

/**
 * Integration test against a real Postgres instance (see docker-compose.yml).
 * Skips automatically when no database is reachable so `npm test` stays
 * green in environments without infra running (e.g. a bare checkout).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://agent:agent@localhost:5432/agent_growth";

async function isDatabaseReachable(): Promise<boolean> {
  const sql = postgres(DATABASE_URL, { max: 1, connect_timeout: 2 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const databaseAvailable = await isDatabaseReachable();

afterAll(async () => {
  if (databaseAvailable) await closeDatabase();
});

describe.skipIf(!databaseAvailable)("SocialAccountRepository", () => {
  it("creates a user and social account, then finds it by id", async () => {
    const db = createDatabase(DATABASE_URL);
    const repo = new SocialAccountRepository(db);
    const userId = await repo.ensureDefaultUser(`test-${Date.now()}@example.com`);
    const created = await repo.create({
      userId,
      platform: "instagram",
      externalAccountId: `ext-${Date.now()}`,
      displayName: "Test Account",
    });

    const found = await repo.findById(created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.displayName).toBe("Test Account");
  });
});
