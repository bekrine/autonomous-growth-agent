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
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];
