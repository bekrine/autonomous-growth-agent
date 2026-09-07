import { relations } from "drizzle-orm";
import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentProfiles } from "./agent.js";
import { contentPosts } from "./content.js";
import { socialAccounts } from "./core.js";
import { experimentStatusEnum } from "./enums.js";

export const analyticsSnapshots = pgTable(
  "analytics_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    contentPostId: uuid("content_post_id").references(() => contentPosts.id, {
      onDelete: "cascade",
    }),
    metricType: text("metric_type").notNull(),
    metrics: jsonb("metrics").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("analytics_snapshots_social_account_id_idx").on(table.socialAccountId),
    index("analytics_snapshots_content_post_id_idx").on(table.contentPostId),
    index("analytics_snapshots_captured_at_idx").on(table.capturedAt),
  ],
);

export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentProfileId: uuid("agent_profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hypothesis: text("hypothesis"),
    status: experimentStatusEnum("status").notNull().default("draft"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("experiments_agent_profile_id_idx").on(table.agentProfileId)],
);

export const experimentVariants = pgTable(
  "experiment_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentPostId: uuid("content_post_id").references(() => contentPosts.id, {
      onDelete: "set null",
    }),
    allocationPct: numeric("allocation_pct").notNull().default("50"),
    results: jsonb("results"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("experiment_variants_experiment_id_idx").on(table.experimentId)],
);

export const analyticsSnapshotsRelations = relations(analyticsSnapshots, ({ one }) => ({
  socialAccount: one(socialAccounts, {
    fields: [analyticsSnapshots.socialAccountId],
    references: [socialAccounts.id],
  }),
  contentPost: one(contentPosts, {
    fields: [analyticsSnapshots.contentPostId],
    references: [contentPosts.id],
  }),
}));

export const experimentsRelations = relations(experiments, ({ one, many }) => ({
  agentProfile: one(agentProfiles, {
    fields: [experiments.agentProfileId],
    references: [agentProfiles.id],
  }),
  variants: many(experimentVariants),
}));

export const experimentVariantsRelations = relations(experimentVariants, ({ one }) => ({
  experiment: one(experiments, {
    fields: [experimentVariants.experimentId],
    references: [experiments.id],
  }),
  contentPost: one(contentPosts, {
    fields: [experimentVariants.contentPostId],
    references: [contentPosts.id],
  }),
}));
