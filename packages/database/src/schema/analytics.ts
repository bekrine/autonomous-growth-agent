import { relations } from "drizzle-orm";
import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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

/**
 * A controlled experiment on one variable (Phase 6).
 *
 * Configuration is stored, not inferred: the sample requirement, observation
 * window and minimum lift are written onto the row when the experiment is
 * created, so an experiment is evaluated against the rules it was designed
 * with — changing the defaults later cannot retroactively turn a past
 * "inconclusive" into a "winner".
 */
export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentProfileId: uuid("agent_profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "cascade" }),
    /** Denormalized from the profile so concurrency rules can be enforced per account cheaply. */
    socialAccountId: uuid("social_account_id").references(() => socialAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hypothesis: text("hypothesis"),
    status: experimentStatusEnum("status").notNull().default("draft"),

    // --- Phase 6 design ---
    /** The single thing being varied: format | topic | hook | cta | caption_style | posting_time. */
    variable: text("variable"),
    /** Canonical analytics metric name the result is judged on. */
    primaryMetric: text("primary_metric"),
    secondaryMetrics: jsonb("secondary_metrics"),
    /** Frozen at creation — see the note above. */
    minSamplesPerVariant: integer("min_samples_per_variant"),
    observationWindowHours: integer("observation_window_hours"),
    maxDurationDays: integer("max_duration_days"),
    minRelativeLift: numeric("min_relative_lift"),
    /** Which agent run proposed it, when the ExperimentAgent did. */
    proposedByAgentRunId: uuid("proposed_by_agent_run_id"),
    /** Free-text reason for pause/cancel/failure — shown to the operator. */
    statusReason: text("status_reason"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("experiments_agent_profile_id_idx").on(table.agentProfileId),
    index("experiments_social_account_id_idx").on(table.socialAccountId),
    index("experiments_status_idx").on(table.status),
  ],
);

/**
 * One arm of an experiment. Exactly one variant per experiment has
 * `role = 'control'`.
 *
 * The variant→posts link is `content_posts.experiment_variant_id` (added in
 * Phase 5), not the legacy 1:1 `content_post_id` column here — a variant needs
 * many posts to reach its sample size. `content_post_id` is retained only so
 * pre-Phase-6 rows remain valid.
 */
export const experimentVariants = pgTable(
  "experiment_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Legacy Phase 1 single-post link. Superseded by content_posts.experiment_variant_id. */
    contentPostId: uuid("content_post_id").references(() => contentPosts.id, {
      onDelete: "set null",
    }),
    /** "control" | "variant" — the control is the baseline arm. */
    role: text("role"),
    /** The value this arm holds for the experiment's variable, e.g. "reel" or "pain_point". */
    variableValue: text("variable_value"),
    description: text("description"),
    /** "active" | "cancelled" — a cancelled variant must never publish. */
    status: text("status").notNull().default("active"),
    targetSampleSize: integer("target_sample_size"),
    allocationPct: numeric("allocation_pct").notNull().default("50"),
    results: jsonb("results"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("experiment_variants_experiment_id_idx").on(table.experimentId),
    unique("experiment_variants_name_key").on(table.experimentId, table.name),
  ],
);

/**
 * Append-only evaluation history.
 *
 * Results are never overwritten: each evaluation is a new row, so an
 * experiment's conclusion can be audited against the data that existed when it
 * was drawn. `evaluation_key` is derived from the sample counts, which makes
 * re-running an evaluation over unchanged data a no-op rather than a duplicate
 * — the database enforces that, not the caller.
 */
export const experimentEvaluations = pgTable(
  "experiment_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    /** Deterministic from the inputs: same samples in, same key. */
    evaluationKey: text("evaluation_key").notNull(),
    /** variant_winner | control_winner | no_clear_winner | inconclusive | insufficient_data */
    outcome: text("outcome").notNull(),
    primaryMetric: text("primary_metric").notNull(),
    controlValue: numeric("control_value"),
    variantValue: numeric("variant_value"),
    relativeLift: numeric("relative_lift"),
    /** low | medium | high — computed, never invented by the LLM. */
    confidence: text("confidence"),
    sampleSizes: jsonb("sample_sizes").notNull(),
    /** Per-variant metric detail plus the thresholds applied, so the verdict is auditable. */
    detail: jsonb("detail"),
    conclusion: text("conclusion"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("experiment_evaluations_experiment_id_idx").on(table.experimentId),
    unique("experiment_evaluations_key").on(table.experimentId, table.evaluationKey),
  ],
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
