import { and, eq, lt } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { oauthStates, socialConnections } from "../schema/index.js";
import type { socialAccountTypeEnum, socialConnectionStatusEnum } from "../schema/enums.js";

type AccountType = (typeof socialAccountTypeEnum.enumValues)[number];
type ConnectionStatus = (typeof socialConnectionStatusEnum.enumValues)[number];

export interface UpsertSocialConnectionInput {
  socialAccountId: string;
  platform: "instagram" | "facebook";
  platformAccountId: string;
  platformUsername?: string;
  accountType: AccountType;
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string;
  tokenExpiresAt?: Date;
  scopes: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Everything except the encrypted token columns. API responses must use this
 * projection — the raw/encrypted token must never leave the server.
 */
export interface SafeSocialConnection {
  id: string;
  socialAccountId: string;
  platform: string;
  platformAccountId: string;
  platformUsername: string | null;
  accountType: AccountType;
  tokenExpiresAt: string | null;
  scopes: unknown;
  status: ConnectionStatus;
  lastError: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

function toSafe(row: typeof socialConnections.$inferSelect): SafeSocialConnection {
  return {
    id: row.id,
    socialAccountId: row.socialAccountId,
    platform: row.platform,
    platformAccountId: row.platformAccountId,
    platformUsername: row.platformUsername,
    accountType: row.accountType,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    scopes: row.scopes,
    status: row.status,
    lastError: row.lastError,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class SocialConnectionRepository {
  constructor(private readonly db: DrizzleClient) {}

  /** Reconnecting the same platform account refreshes the existing row instead of duplicating it. */
  async upsert(input: UpsertSocialConnectionInput) {
    const [row] = await this.db
      .insert(socialConnections)
      .values({ ...input, status: "connected", lastError: null })
      .onConflictDoUpdate({
        target: [socialConnections.platform, socialConnections.platformAccountId],
        set: {
          socialAccountId: input.socialAccountId,
          platformUsername: input.platformUsername,
          accountType: input.accountType,
          accessTokenEncrypted: input.accessTokenEncrypted,
          refreshTokenEncrypted: input.refreshTokenEncrypted,
          tokenExpiresAt: input.tokenExpiresAt,
          scopes: input.scopes,
          metadata: input.metadata ?? {},
          status: "connected",
          lastError: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  /** Internal use only — includes encrypted tokens. Never return this from a route. */
  async findByIdWithSecrets(id: string) {
    const [row] = await this.db.select().from(socialConnections).where(eq(socialConnections.id, id));
    return row ?? null;
  }

  async findById(id: string): Promise<SafeSocialConnection | null> {
    const row = await this.findByIdWithSecrets(id);
    return row ? toSafe(row) : null;
  }

  async listByAccount(socialAccountId: string): Promise<SafeSocialConnection[]> {
    const rows = await this.db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.socialAccountId, socialAccountId));
    return rows.map(toSafe);
  }

  async listAll(): Promise<SafeSocialConnection[]> {
    const rows = await this.db.select().from(socialConnections);
    return rows.map(toSafe);
  }

  async findActiveForAccount(socialAccountId: string, platform: "instagram" | "facebook") {
    const [row] = await this.db
      .select()
      .from(socialConnections)
      .where(
        and(
          eq(socialConnections.socialAccountId, socialAccountId),
          eq(socialConnections.platform, platform),
          eq(socialConnections.status, "connected"),
        ),
      );
    return row ?? null;
  }

  async updateStatus(id: string, status: ConnectionStatus, lastError?: string) {
    const [row] = await this.db
      .update(socialConnections)
      .set({ status, lastError: lastError ?? null, updatedAt: new Date() })
      .where(eq(socialConnections.id, id))
      .returning();
    return row;
  }

  async delete(id: string) {
    await this.db.delete(socialConnections).where(eq(socialConnections.id, id));
  }

  // --- OAuth state (CSRF protection) ---

  async createState(input: {
    state: string;
    platform: "instagram" | "facebook";
    socialAccountId: string;
    redirectUri: string;
    expiresAt: Date;
  }) {
    const [row] = await this.db.insert(oauthStates).values(input).returning();
    return row;
  }

  /**
   * Single-use: the row is deleted as it's read, so a replayed callback can
   * never validate twice. Returns null for unknown or expired state.
   */
  async consumeState(state: string) {
    const [row] = await this.db.delete(oauthStates).where(eq(oauthStates.state, state)).returning();
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    return row;
  }

  async deleteExpiredStates() {
    await this.db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  }
}
