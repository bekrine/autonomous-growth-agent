/**
 * Queue names shared between the API (producer) and workers (consumers).
 * Keeping this list in one place means adding a queue never requires
 * touching both sides independently.
 */
export const QUEUE_NAMES = [
  "research",
  "strategy",
  "content",
  "publishing",
  "analytics",
  "experiments",
  // Whole-run execution: a job here re-runs the same AgentRunService the
  // API uses synchronously, so the business logic exists in exactly one
  // place regardless of which path triggered it.
  "agent-run",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export const AGENT_RUN_JOB_NAME = "run-agent";

export interface AgentRunJobData {
  accountId: string;
  /** Present when resuming/retrying a specific run instead of starting a new one. */
  runId?: string;
}

/**
 * Runs the full ContentCreator -> media generation -> Reviewer pipeline
 * (with its internal regeneration loop) for one content idea. Reuses the
 * existing "content" queue rather than introducing a new one.
 */
export const GENERATE_CONTENT_JOB_NAME = "generate-content";

export interface GenerateContentJobData {
  accountId: string;
  contentIdeaId: string;
  /** Present when resuming/retrying a specific content-generation run instead of starting a new one. */
  runId?: string;
}

/**
 * Publishes one approved content post to a social platform. The job carries
 * only the publishing_jobs row id — every other detail (content, connection,
 * idempotency key, attempt count) is read from Postgres by PublishingService,
 * so a delayed or redelivered job always acts on current state rather than a
 * stale snapshot captured at enqueue time.
 */
export const PUBLISH_CONTENT_JOB_NAME = "publish-content";

export interface PublishContentJobData {
  publishingJobId: string;
}
