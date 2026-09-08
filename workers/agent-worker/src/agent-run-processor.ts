import type { Job } from "bullmq";
import type { AgentRunService } from "@agent/agent-core";
import type { Logger } from "@agent/shared";
import type { AgentRunJobData } from "@agent/shared";

/**
 * Processes jobs on the "agent-run" queue by calling the exact same
 * AgentRunService the API calls synchronously from POST /api/agent/runs
 * — this file contains no business logic of its own, only job plumbing.
 * `job.data.runId`, when present (a redelivered/retried job), resumes
 * that run instead of starting a new one; AgentOrchestrator's per-stage
 * idempotency checks make this safe to call more than once.
 */
export function createAgentRunProcessor(agentRunService: AgentRunService, logger: Logger) {
  return async (job: Job<AgentRunJobData>) => {
    const { accountId, runId } = job.data;
    logger.info({ jobId: job.id, accountId, runId }, "agent-worker.agent_run_job_received");

    const result = runId
      ? await agentRunService.resumeRun(accountId, runId)
      : await agentRunService.startRun(accountId);

    if (result.status === "failed") {
      // Throwing lets BullMQ apply its own retry/backoff policy for this job.
      throw new Error(`agent run ${result.runId} failed: ${result.error ?? "unknown error"}`);
    }

    return { runId: result.runId, status: result.status };
  };
}
