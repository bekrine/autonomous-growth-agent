/**
 * Cross-cutting domain enums/types referenced by database, agent-core,
 * social-platforms and policies. Keep this file free of platform-specific
 * fields (e.g. no Instagram media_type) — those belong in
 * packages/social-platforms.
 */

export const SOCIAL_PLATFORMS = ["instagram", "facebook"] as const;
export type SocialPlatformName = (typeof SOCIAL_PLATFORMS)[number];

export const AGENT_NAMES = [
  "research",
  "strategy",
  "content_planner",
  "content_creator",
  "reviewer",
  "analytics",
  "experiment",
  "community",
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENT_RUN_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const CONTENT_POST_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "scheduled",
  "published",
  "failed",
  "rejected",
] as const;
export type ContentPostStatus = (typeof CONTENT_POST_STATUSES)[number];

export const PUBLISHING_JOB_STATUSES = ["queued", "processing", "succeeded", "failed"] as const;
export type PublishingJobStatus = (typeof PUBLISHING_JOB_STATUSES)[number];

export const EXPERIMENT_STATUSES = ["draft", "running", "completed", "aborted"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
