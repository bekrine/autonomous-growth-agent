import type { Job } from "bullmq";
import type { PublishingService } from "@agent/agent-core";
import type { Logger, PublishContentJobData } from "@agent/shared";

/**
 * Processes "publish-content" jobs by calling the exact same
 * PublishingService the API calls. This file contains no publishing
 * business logic — no policy checks, no Meta calls, no state transitions.
 * All of that lives in the service so the HTTP and queue paths behave
 * identically.
 *
 * The service is idempotent and performs its own final state check, so a
 * redelivered or duplicated job cannot double-publish.
 */
export function createPublishingProcessor(publishingService: PublishingService, logger: Logger) {
  return async (job: Job<PublishContentJobData>) => {
    const { publishingJobId } = job.data;
    logger.info({ jobId: job.id, publishingJobId }, "publishing-worker.job_received");

    const result = await publishingService.execute(publishingJobId);

    // Only throw when another attempt could plausibly help. The service has
    // already recorded the terminal state; throwing on a permanent failure
    // would just make BullMQ retry something that cannot succeed.
    if (result.status === "failed") {
      const jobRow = await publishingService.getJob(publishingJobId);
      if (jobRow.status === "retry_scheduled") {
        throw new Error(`publishing job ${publishingJobId} failed (${result.errorCode}) — retrying`);
      }
      logger.warn(
        { publishingJobId, errorCode: result.errorCode },
        "publishing-worker.permanent_failure_no_retry",
      );
    }

    return { publishingJobId, status: result.status, externalPostId: result.externalPostId };
  };
}
