import type { Job } from "bullmq";
import type { AnalyticsService } from "@agent/agent-core";
import {
  CONTENT_PUBLISHED_EVENT,
  type CollectAnalyticsJobData,
  type ContentPublishedJobData,
  type Logger,
} from "@agent/shared";

/**
 * Job plumbing only — every decision lives in AnalyticsService, exactly as the
 * publishing worker delegates to PublishingService. This file contains no
 * metric logic, no Meta calls and no scheduling rules, so the queue path and
 * the API path cannot drift.
 *
 * Two job kinds arrive here:
 *   content.published   — a post just went live; register it for collection
 *   collect-analytics   — collect one post, or sweep everything now due
 */
export function createAnalyticsProcessor(analyticsService: AnalyticsService, logger: Logger) {
  return async (job: Job<ContentPublishedJobData | CollectAnalyticsJobData>) => {
    if (job.name === CONTENT_PUBLISHED_EVENT) {
      const data = job.data as ContentPublishedJobData;
      logger.info({ jobId: job.id, contentPostId: data.contentPostId }, "analytics-worker.content_published");

      await analyticsService.schedulePostCollection({
        contentPostId: data.contentPostId,
        socialAccountId: data.socialAccountId,
        externalPostId: data.externalPostId,
        platform: data.platform,
        publishedAt: new Date(data.publishedAt),
      });

      return { scheduled: true, contentPostId: data.contentPostId };
    }

    const data = (job.data ?? {}) as CollectAnalyticsJobData;

    if (data.contentPostId) {
      const result = await analyticsService.collectForPost(data.contentPostId, { window: data.collectionWindow });
      // A failed collection is a recorded outcome, not a job failure: the
      // service already decided whether another attempt is worthwhile and set
      // nextSnapshotAt accordingly. Throwing here would add a second,
      // uncoordinated retry loop on top of that.
      return result;
    }

    // Sweep: collect every post whose window is due. Serial by design — the
    // point is bounded API usage, not throughput.
    const due = await analyticsService.findPostsDueForCollection(new Date());
    const results = [];
    for (const state of due) {
      results.push(await analyticsService.collectForPost(state.contentPostId));
    }

    if (data.socialAccountId) {
      results.push(await analyticsService.collectAccountSnapshot(data.socialAccountId));
    }

    logger.info({ jobId: job.id, collected: results.length }, "analytics-worker.sweep_complete");
    return { collected: results.length, results };
  };
}
