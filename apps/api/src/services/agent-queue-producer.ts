import { Queue } from "bullmq";
import type { RedisConnection } from "@agent/shared";
import { AGENT_RUN_JOB_NAME, type AgentRunJobData } from "@agent/shared";

/**
 * Enqueues an agent run onto the "agent-run" BullMQ queue instead of
 * running it synchronously. workers/agent-worker consumes this queue by
 * calling the exact same AgentRunService the API calls directly — this
 * class only produces jobs, it contains no run logic itself.
 */
export class AgentQueueProducer {
  private readonly queue: Queue<AgentRunJobData>;

  constructor(connection: RedisConnection) {
    this.queue = new Queue<AgentRunJobData>("agent-run", { connection });
  }

  async enqueueRun(accountId: string): Promise<{ jobId: string }> {
    const job = await this.queue.add(AGENT_RUN_JOB_NAME, { accountId });
    return { jobId: job.id ?? "" };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
