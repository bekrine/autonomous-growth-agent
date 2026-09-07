import type { Job } from "bullmq";
import type { Logger } from "@agent/shared";

/**
 * Placeholder processors — one per agent-related queue. Each just logs and
 * acknowledges the job. Real implementations will call into
 * @agent/agent-core (e.g. re-running a specific agent step, or resuming an
 * AgentRun) once the orchestrator supports partial/async execution.
 */
export function createPlaceholderProcessor(queueName: string, logger: Logger) {
  return async (job: Job) => {
    logger.info({ queue: queueName, jobId: job.id, data: job.data }, "worker.job_received");
    return { processed: true, queue: queueName };
  };
}
