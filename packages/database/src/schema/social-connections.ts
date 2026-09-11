import { relations } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { socialAccounts } from "./core.js";
import { socialAccountTypeEnum, socialConnectionStatusEnum, socialPlatformEnum } from "./enums.js";

/**
 * An authorized link between one of our social_accounts and a real platform
 * account (e.g. an Instagram Professional account reached via a Meta app).
 *
 * Tokens are stored ENCRYPTED (AES-256-GCM, see packages/shared/src/crypto.ts)
 * and must never be selected into an API response — repositories expose
 * explicit "safe" projections for that. `social_accounts.accessToken` remains
 * a Phase 1 plaintext placeholder and is unused by Phase 4.
 */
export const socialConnections = pgTable(
  "social_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    platform: socialPlatformEnum("platform").notNull(),
    platformAccountId: text("platform_account_id").notNull(),
    platformUsername: text("platform_username"),
    accountType: socialAccountTypeEnum("account_type").notNull().default("unknown"),
    // Nullable so `revoke()` can destroy the credential while keeping the row
    // for audit. A connection with a null token can never be `connected`.
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scopes: jsonb("scopes").notNull().default([]),
    status: socialConnectionStatusEnum("status").notNull().default("connected"),
    lastError: text("last_error"),
    /** Non-sensitive platform detail only (e.g. linked page id, profile picture URL). Never tokens. */
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Reconnecting the same platform account updates the existing row rather
    // than accumulating duplicates.
    unique("social_connections_platform_account_key").on(table.platform, table.platformAccountId),
    index("social_connections_social_account_id_idx").on(table.socialAccountId),
    index("social_connections_status_idx").on(table.status),
  ],
);

/**
 * Short-lived OAuth `state` values. Persisted rather than kept in memory so
 * the callback validates correctly across restarts and multiple API
 * instances, and so a state can be single-use (deleted on consumption).
 */
export const oauthStates = pgTable(
  "oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: text("state").notNull().unique(),
    platform: socialPlatformEnum("platform").notNull(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("oauth_states_expires_at_idx").on(table.expiresAt)],
);

export const socialConnectionsRelations = relations(socialConnections, ({ one }) => ({
  socialAccount: one(socialAccounts, {
    fields: [socialConnections.socialAccountId],
    references: [socialAccounts.id],
  }),
}));

export const oauthStatesRelations = relations(oauthStates, ({ one }) => ({
  socialAccount: one(socialAccounts, {
    fields: [oauthStates.socialAccountId],
    references: [socialAccounts.id],
  }),
}));
