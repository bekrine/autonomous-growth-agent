import { relations } from "drizzle-orm";
import { index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { socialAccounts } from "./core.js";
import { goalStatusEnum } from "./enums.js";
import { agentRuns } from "./runtime.js";

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .unique()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    niche: text("niche").notNull(),
    audienceDescription: text("audience_description"),
    tone: text("tone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("agent_profiles_social_account_id_idx").on(table.socialAccountId)],
);

export const agentGoals = pgTable(
  "agent_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentProfileId: uuid("agent_profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    metric: text("metric").notNull(),
    targetValue: numeric("target_value"),
    deadline: timestamp("deadline", { withTimezone: true }),
    status: goalStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("agent_goals_agent_profile_id_idx").on(table.agentProfileId)],
);

export const agentStrategies = pgTable(
  "agent_strategies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentProfileId: uuid("agent_profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Nullable, set once the first strategy_versions row is created.
    currentVersionId: uuid("current_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("agent_strategies_agent_profile_id_idx").on(table.agentProfileId)],
);

export const strategyVersions = pgTable(
  "strategy_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    strategyId: uuid("strategy_id")
      .notNull()
      .references(() => agentStrategies.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    summary: text("summary").notNull(),
    content: jsonb("content").notNull(),
    createdBy: text("created_by").notNull(),
    // Which agent run produced this version, if any — traceability + the
    // idempotency check that stops a retried run from creating a duplicate.
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("strategy_versions_strategy_id_idx").on(table.strategyId),
    index("strategy_versions_strategy_id_version_idx").on(table.strategyId, table.versionNumber),
    index("strategy_versions_agent_run_id_idx").on(table.agentRunId),
  ],
);

export const agentProfilesRelations = relations(agentProfiles, ({ one, many }) => ({
  socialAccount: one(socialAccounts, {
    fields: [agentProfiles.socialAccountId],
    references: [socialAccounts.id],
  }),
  goals: many(agentGoals),
  strategies: many(agentStrategies),
}));

export const agentGoalsRelations = relations(agentGoals, ({ one }) => ({
  agentProfile: one(agentProfiles, {
    fields: [agentGoals.agentProfileId],
    references: [agentProfiles.id],
  }),
}));

export const agentStrategiesRelations = relations(agentStrategies, ({ one, many }) => ({
  agentProfile: one(agentProfiles, {
    fields: [agentStrategies.agentProfileId],
    references: [agentProfiles.id],
  }),
  versions: many(strategyVersions),
}));

export const strategyVersionsRelations = relations(strategyVersions, ({ one }) => ({
  strategy: one(agentStrategies, {
    fields: [strategyVersions.strategyId],
    references: [agentStrategies.id],
  }),
}));
