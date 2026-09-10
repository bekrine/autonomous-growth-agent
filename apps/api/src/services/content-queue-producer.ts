import { Queue } from "bullmq";
import type { RedisConnection } from "@agent/shared";
import { GENERATE_CONTENT_JOB_NAME, type GenerateContentJobData } from "@agent/shared";

/**
 * Enqueues a content-generation run onto the "content" BullMQ queue
 * instead of running it synchronously. workers/agent-worker consumes this
 * queue by calling the exact same AgentRunService.generateContent the API
 * calls directly — this class only produces jobs, it contains no
 * generation logic itself.
 */
export class ContentQueueProducer {
  private readonly queue: Queue<GenerateContentJobData>;

  constructor(connection: RedisConnection) {
    this.queue = new Queue<GenerateContentJobData>("content", { connection });
  }

  async enqueueGeneration(accountId: string, contentIdeaId: string): Promise<{ jobId: string }> {
    const job = await this.queue.add(GENERATE_CONTENT_JOB_NAME, { accountId, contentIdeaId });
    return { jobId: job.id ?? "" };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
