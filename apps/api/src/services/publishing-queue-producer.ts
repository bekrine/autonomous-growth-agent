import { Queue } from "bullmq";
import type { RedisConnection } from "@agent/shared";
import { PUBLISH_CONTENT_JOB_NAME, type PublishContentJobData } from "@agent/shared";

/**
 * Adds jobs to the existing "publishing" BullMQ queue.
 *
 * Normally the outbox publisher drives this (enqueue writes an outbox event
 * in the same transaction as the job row, and the publisher turns it into a
 * BullMQ job) — this class exists so the API can also enqueue directly where
 * an outbox round-trip would add latency for no benefit.
 *
 * Scheduling uses BullMQ's `delay`, not setTimeout: the delay survives a
 * process restart because it lives in Redis, and `publishing_jobs.scheduled_for`
 * in Postgres remains the durable source of truth either way.
 */
export class PublishingQueueProducer {
  private readonly queue: Queue<PublishContentJobData>;

  constructor(connection: RedisConnection) {
    this.queue = new Queue<PublishContentJobData>("publishing", { connection });
  }

  async enqueuePublish(publishingJobId: string, delayMs = 0): Promise<{ jobId: string }> {
    const job = await this.queue.add(
      PUBLISH_CONTENT_JOB_NAME,
      { publishingJobId },
      {
        delay: delayMs > 0 ? delayMs : undefined,
        // Deterministic job id: a redelivered outbox event maps to the same
        // BullMQ job rather than queueing the publish twice.
        jobId: `publish:${publishingJobId}`,
      },
    );
    return { jobId: job.id ?? "" };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
