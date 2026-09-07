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

export const contentPostStatusEnum = pgEnum("content_post_status", [
  "draft",
  "pending_review",
  "approved",
  "scheduled",
  "published",
  "failed",
  "rejected",
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
