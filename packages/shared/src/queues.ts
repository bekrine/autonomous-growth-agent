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
