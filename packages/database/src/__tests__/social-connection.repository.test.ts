import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDatabase, createDatabase } from "../client.js";
import { SocialAccountRepository } from "../repositories/social-account.repository.js";
import { SocialConnectionRepository } from "../repositories/social-connection.repository.js";

/**
 * Integration test against a real Postgres instance (see docker-compose.yml).
 * Skips automatically when no database is reachable.
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

async function seedConnection() {
  const db = createDatabase(DATABASE_URL);
  const accounts = new SocialAccountRepository(db);
  const connections = new SocialConnectionRepository(db);
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const userId = await accounts.ensureDefaultUser(`conn-${unique}@example.com`);
  const account = await accounts.create({
    userId,
    platform: "instagram",
    externalAccountId: `conn-ext-${unique}`,
    displayName: "Connection Test Account",
  });

  const connection = await connections.upsert({
    socialAccountId: account.id,
    platform: "instagram",
    platformAccountId: `1784140000${Math.floor(Math.random() * 100000)}`,
    platformUsername: "test_account",
    accountType: "business",
    accessTokenEncrypted: "v1:ciphertext-stand-in",
    scopes: ["instagram_basic", "instagram_content_publish"],
  });

  return { db, connections, account, connection };
}

describe.skipIf(!databaseAvailable)("SocialConnectionRepository", () => {
  it("reconnecting the same platform account updates the row instead of duplicating it", async () => {
    const { connections, account, connection } = await seedConnection();
    const withSecrets = await connections.findByIdWithSecrets(connection.id);

    const again = await connections.upsert({
      socialAccountId: account.id,
      platform: "instagram",
      platformAccountId: withSecrets!.platformAccountId,
      platformUsername: "renamed_account",
      accountType: "business",
      accessTokenEncrypted: "v1:rotated-ciphertext",
      scopes: ["instagram_basic"],
    });

    expect(again.id).toBe(connection.id);
    const all = await connections.listByAccount(account.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.platformUsername).toBe("renamed_account");
  });

  it("revoking destroys the stored credential but keeps the row for audit", async () => {
    const { connections, connection } = await seedConnection();

    const revoked = await connections.revoke(connection.id);

    expect(revoked!.status).toBe("revoked");
    // The ciphertext is gone, not merely flagged unusable.
    expect(revoked!.accessTokenEncrypted).toBeNull();
    expect(revoked!.refreshTokenEncrypted).toBeNull();
    expect(revoked!.tokenExpiresAt).toBeNull();

    // The row survives, so historical publishing_jobs still resolve to it.
    const found = await connections.findById(connection.id);
    expect(found?.id).toBe(connection.id);
  });

  it("does not expose token ciphertext through the safe projection", async () => {
    const { connections, connection } = await seedConnection();
    const safe = await connections.findById(connection.id);

    expect(safe).not.toBeNull();
    expect(JSON.stringify(safe)).not.toContain("ciphertext-stand-in");
    expect(safe as unknown as Record<string, unknown>).not.toHaveProperty("accessTokenEncrypted");
  });

  it("a revoked connection is no longer returned as active", async () => {
    const { connections, account, connection } = await seedConnection();

    expect(await connections.findActiveForAccount(account.id, "instagram")).not.toBeNull();
    await connections.revoke(connection.id);
    expect(await connections.findActiveForAccount(account.id, "instagram")).toBeNull();
  });
});
