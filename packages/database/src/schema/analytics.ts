import { relations } from "drizzle-orm";
import { boolean, index, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agentProfiles } from "./agent.js";
import { contentPosts } from "./content.js";
import { socialAccounts } from "./core.js";
import { experimentStatusEnum } from "./enums.js";

/**
 * Append-only history of what the platform reported. Rows are never updated
 * or overwritten: "current followers" is the newest snapshot, not a mutated
 * field, so follower history survives (see docs/analytics.md).
 *
 * `metrics` holds the sanitized raw provider payload; the normalized numbers
 * live in `analytics_metrics`. Raw is kept alongside normalized rather than
 * replaced by it, so a normalization bug can be diagnosed after the fact.
 */
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
    /** "media" | "account" — kept as text for forward compatibility. */
    metricType: text("metric_type").notNull(),
    metrics: jsonb("metrics").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // --- Phase 5 additions ---
    /** Which exact generated version this measures — the link the learning phase needs. */
    contentGenerationId: uuid("content_generation_id"),
    socialConnectionId: uuid("social_connection_id"),
    platform: text("platform"),
    /** The platform's own post id; analytics are fetched by this, not by our local id. */
    externalPostId: text("external_post_id"),
    /** Which scheduled window produced this row: initial | early | daily | extended | manual. */
    collectionWindow: text("collection_window"),
    /** complete | partial | failed — a partial snapshot must not look fully successful. */
    outcome: text("outcome"),
    errorReason: text("error_reason"),
  },
  (table) => [
    index("analytics_snapshots_social_account_id_idx").on(table.socialAccountId),
    index("analytics_snapshots_content_post_id_idx").on(table.contentPostId),
    index("analytics_snapshots_captured_at_idx").on(table.capturedAt),
    /**
     * Database-enforced idempotency: one snapshot per (post, type, window).
     * A redelivered job or a double-scheduled window cannot create a second
     * row, so averages built on snapshots stay correct under retry.
     *
     * NULLS NOT DISTINCT is essential, not decoration: account-level snapshots
     * have a NULL content_post_id, and Postgres's default treats every NULL as
     * distinct — which would let the same account/day insert repeatedly and
     * silently corrupt follower history.
     */
    unique("analytics_snapshots_idempotency_key")
      .on(table.socialAccountId, table.contentPostId, table.metricType, table.collectionWindow)
      .nullsNotDistinct(),
  ],
);

/**
 * Normalized metrics, one row per measurement. Storing metrics as rows rather
 * than columns means a new platform metric needs no migration — which matters
 * because Meta's metric set changes (impressions → views, April 2025).
 *
 * `available = false` records "the platform did not give us this", which is
 * categorically different from `value = 0`. Derived metrics refuse to compute
 * rather than treat a missing denominator as zero.
 */
export const analyticsMetrics = pgTable(
  "analytics_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => analyticsSnapshots.id, { onDelete: "cascade" }),
    /** Our canonical name (e.g. "views"), stable across platform renames. */
    metricName: text("metric_name").notNull(),
    /** The platform's own name (e.g. "impressions"), retained for traceability. */
    platformMetricName: text("platform_metric_name"),
    metricValue: numeric("metric_value"),
    metricUnit: text("metric_unit").notNull().default("count"),
    available: boolean("available").notNull().default(true),
    unavailableReason: text("unavailable_reason"),
    /** "platform" for measured values, "derived" for calculated ones. */
    source: text("source").notNull().default("platform"),
    /** Formula + inputs for derived metrics, so every calculation is auditable. */
    computation: jsonb("computation"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("analytics_metrics_snapshot_id_idx").on(table.snapshotId),
    index("analytics_metrics_name_idx").on(table.metricName),
    unique("analytics_metrics_snapshot_metric_key").on(table.snapshotId, table.metricName),
  ],
);

/**
 * Per-post analytics collection state, separate from the snapshots themselves.
 * This is what stops API storms: the worker selects only posts whose
 * `nextSnapshotAt` has arrived and whose status still warrants collection.
 */
export const contentAnalyticsState = pgTable(
  "content_analytics_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentPostId: uuid("content_post_id")
      .notNull()
      .references(() => contentPosts.id, { onDelete: "cascade" })
      .unique(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    externalPostId: text("external_post_id"),
    platform: text("platform"),
    /** pending | collecting | up_to_date | partial | failed */
    status: text("status").notNull().default("pending"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastSnapshotAt: timestamp("last_snapshot_at", { withTimezone: true }),
    nextSnapshotAt: timestamp("next_snapshot_at", { withTimezone: true }),
    /** Which windows have been captured, so each runs at most once. */
    completedWindows: jsonb("completed_windows").notNull().default([]),
    attempts: numeric("attempts").notNull().default("0"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("content_analytics_state_status_idx").on(table.status),
    index("content_analytics_state_next_snapshot_idx").on(table.nextSnapshotAt),
  ],
);

/**
 * Structured observations produced by the AnalyticsAgent. Deliberately
 * separate from `strategy_versions`: Phase 5 measures and explains, it does
 * not change strategy. Nothing here feeds back into planning yet.
 */
export const analyticsInsights = pgTable(
  "analytics_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id"),
    /** format | topic | content_pillar | hook | cta | posting_time | audience_response | growth | anomaly */
    insightType: text("insight_type").notNull(),
    dimension: text("dimension"),
    dimensionValue: text("dimension_value"),
    finding: text("finding").notNull(),
    /** Concise reasoning summary — never hidden chain-of-thought. */
    evidence: jsonb("evidence"),
    confidence: numeric("confidence"),
    sampleSize: numeric("sample_size"),
    timeRangeStart: timestamp("time_range_start", { withTimezone: true }),
    timeRangeEnd: timestamp("time_range_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("analytics_insights_social_account_id_idx").on(table.socialAccountId),
    index("analytics_insights_type_idx").on(table.insightType),
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
