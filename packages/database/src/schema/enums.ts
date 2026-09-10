import { pgEnum } from "drizzle-orm/pg-core";

export const socialPlatformEnum = pgEnum("social_platform", ["instagram", "facebook"]);

export const socialAccountStatusEnum = pgEnum("social_account_status", [
  "active",
  "disconnected",
  "error",
]);

export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

// Phase 3 content-generation lifecycle values were appended (not substituted)
// so this migrates via non-destructive ALTER TYPE ... ADD VALUE statements.
// "draft"/"pending_review"/"rejected" predate Phase 3 and are unused by any
// code path today; kept rather than force a full enum-type recreation.
export const contentPostStatusEnum = pgEnum("content_post_status", [
  "draft",
  "pending_review",
  "approved",
  "scheduled",
  "published",
  "failed",
  "rejected",
  "idea",
  "brief_created",
  "generating",
  "generated",
  "reviewing",
  "ready_for_publishing",
  "generation_failed",
  "review_failed",
]);

export const contentIdeaStatusEnum = pgEnum("content_idea_status", [
  "proposed",
  "approved",
  "rejected",
  "used",
]);

export const publishingJobStatusEnum = pgEnum("publishing_job_status", [
  "queued",
  "processing",
  "succeeded",
  "failed",
]);

export const experimentStatusEnum = pgEnum("experiment_status", [
  "draft",
  "running",
  "completed",
  "aborted",
]);

export const goalStatusEnum = pgEnum("goal_status", ["active", "completed", "abandoned"]);

export const agentActionStatusEnum = pgEnum("agent_action_status", [
  "pending",
  "succeeded",
  "failed",
]);

export const outboxEventStatusEnum = pgEnum("outbox_event_status", [
  "pending",
  "published",
  "failed",
]);

export const contentGenerationStatusEnum = pgEnum("content_generation_status", [
  "generating",
  "generated",
  "generation_failed",
]);

export const mediaAssetTypeEnum = pgEnum("media_asset_type", ["image", "video"]);

export const mediaAssetStatusEnum = pgEnum("media_asset_status", [
  "requested",
  "generating",
  "completed",
  "failed",
]);
