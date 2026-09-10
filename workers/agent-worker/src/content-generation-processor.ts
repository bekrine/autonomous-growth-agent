import type { Job } from "bullmq";
import type { AgentRunService } from "@agent/agent-core";
import type { Logger } from "@agent/shared";
import type { GenerateContentJobData } from "@agent/shared";

/**
 * Processes jobs on the "content" queue's "generate-content" job type by
 * calling the exact same AgentRunService.generateContent the API calls
 * synchronously from POST /api/content/:id/generate — no business logic
 * lives here, only job plumbing. `job.data.runId`, when present (a
 * redelivered/retried job), resumes that content-generation run instead of
 * starting a new one; the orchestrator's per-attempt idempotency checks
 * make this safe to call more than once.
 */
export function createContentGenerationProcessor(agentRunService: AgentRunService, logger: Logger) {
  return async (job: Job<GenerateContentJobData>) => {
    const { accountId, contentIdeaId, runId } = job.data;
    logger.info({ jobId: job.id, accountId, contentIdeaId, runId }, "agent-worker.generate_content_job_received");

    const result = runId
      ? await agentRunService.resumeContentGeneration(accountId, contentIdeaId, runId)
      : await agentRunService.generateContent(accountId, contentIdeaId);

    if (result.status === "generation_failed") {
      // Throwing lets BullMQ apply its own retry/backoff policy for this job.
      throw new Error(`content generation for idea ${contentIdeaId} failed: ${result.error ?? "unknown error"}`);
    }

    return { contentId: result.contentId, status: result.status };
  };
}
