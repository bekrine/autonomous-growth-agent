import { relations } from "drizzle-orm";
import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { contentPosts } from "./content.js";
import { agentRuns } from "./runtime.js";
import { contentGenerationStatusEnum, mediaAssetStatusEnum, mediaAssetTypeEnum } from "./enums.js";

/**
 * One row per ContentCreatorAgent generation attempt for a content_post —
 * append-only, never overwritten, so the full v1/v2/v3/... history stays
 * queryable (needed later so the learning system can compare which
 * generated version performed best). `payload` holds the full structured
 * GeneratedContent object (format-specific: ReelContent/CarouselContent/
 * ImageContent/TextContent — see packages/agent-core/src/prompts/content-creator).
 */
export const contentGenerations = pgTable(
  "content_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentPostId: uuid("content_post_id")
      .notNull()
      .references(() => contentPosts.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    format: text("format").notNull(),
    payload: jsonb("payload"),
    status: contentGenerationStatusEnum("status").notNull().default("generating"),
    errorMessage: text("error_message"),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    llmProvider: text("llm_provider"),
    llmModel: text("llm_model"),
    durationMs: integer("duration_ms"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("content_generations_content_post_id_idx").on(table.contentPostId),
    // One version number per post — the idempotency key a retried job checks first.
    unique("content_generations_post_id_version_key").on(table.contentPostId, table.versionNumber),
  ],
);

/** One review per generation. A generation can only ever be reviewed once — re-reviewing means generating a new version. */
export const contentReviews = pgTable(
  "content_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentGenerationId: uuid("content_generation_id")
      .notNull()
      .unique()
      .references(() => contentGenerations.id, { onDelete: "cascade" }),
    approved: boolean("approved").notNull(),
    score: numeric("score").notNull(),
    qualityScore: numeric("quality_score").notNull(),
    brandScore: numeric("brand_score").notNull(),
    safetyScore: numeric("safety_score").notNull(),
    issues: jsonb("issues").notNull().default([]),
    warnings: jsonb("warnings").notNull().default([]),
    recommendedChanges: jsonb("recommended_changes").notNull().default([]),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("content_reviews_content_generation_id_idx").on(table.contentGenerationId)],
);

/**
 * Asset *metadata* only — the actual file lives in object storage
 * (packages/media's ObjectStorage), never in this table/Postgres.
 */
export const contentAssets = pgTable(
  "content_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentGenerationId: uuid("content_generation_id")
      .notNull()
      .references(() => contentGenerations.id, { onDelete: "cascade" }),
    assetType: mediaAssetTypeEnum("asset_type").notNull(),
    storageKey: text("storage_key"),
    url: text("url"),
    mimeType: text("mime_type"),
    provider: text("provider").notNull(),
    providerAssetId: text("provider_asset_id"),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: numeric("duration_seconds"),
    status: mediaAssetStatusEnum("status").notNull().default("requested"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("content_assets_content_generation_id_idx").on(table.contentGenerationId)],
);

export const contentGenerationsRelations = relations(contentGenerations, ({ one, many }) => ({
  contentPost: one(contentPosts, {
    fields: [contentGenerations.contentPostId],
    references: [contentPosts.id],
  }),
  review: one(contentReviews, {
    fields: [contentGenerations.id],
    references: [contentReviews.contentGenerationId],
  }),
  assets: many(contentAssets),
}));

export const contentReviewsRelations = relations(contentReviews, ({ one }) => ({
  contentGeneration: one(contentGenerations, {
    fields: [contentReviews.contentGenerationId],
    references: [contentGenerations.id],
  }),
}));

export const contentAssetsRelations = relations(contentAssets, ({ one }) => ({
  contentGeneration: one(contentGenerations, {
    fields: [contentAssets.contentGenerationId],
    references: [contentGenerations.id],
  }),
}));
