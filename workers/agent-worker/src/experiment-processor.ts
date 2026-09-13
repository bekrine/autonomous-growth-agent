import type { Job } from "bullmq";
import type { ExperimentService } from "@agent/agent-core";
import type { Logger } from "@agent/shared";

/**
 * Job plumbing for the `experiments` queue — no experiment logic lives here.
 *
 * Same rule as the publishing and analytics processors: the decisions belong to
 * ExperimentService, so the queue path and the API path cannot drift.
 */

export const EXPERIMENT_JOBS = {
  checkProgress: "check-experiment-progress",
  evaluate: "evaluate-experiment",
} as const;

export interface ExperimentJobData {
  experimentId: string;
}

export function createExperimentProcessor(experimentService: ExperimentService, logger: Logger) {
  return async (job: Job<ExperimentJobData>) => {
    const { experimentId } = job.data ?? {};
    if (!experimentId) {
      logger.warn({ jobId: job.id, name: job.name }, "experiment-worker.missing_experiment_id");
      return { skipped: true };
    }

    switch (job.name) {
      case EXPERIMENT_JOBS.checkProgress: {
        const progress = await experimentService.getProgress(experimentId);
        logger.info(
          { experimentId, status: progress.status, readyToEvaluate: progress.readyToEvaluate },
          "experiment-worker.progress_checked",
        );

        // Evaluating early would just record an "insufficient data" verdict and
        // burn an evaluation row, so we only evaluate once every arm has met
        // its target.
        if (!progress.readyToEvaluate) return { experimentId, evaluated: false, progress };

        const { evaluation, created } = await experimentService.evaluate(experimentId);
        return { experimentId, evaluated: true, created, outcome: evaluation.outcome };
      }

      case EXPERIMENT_JOBS.evaluate: {
        const { evaluation, created } = await experimentService.evaluate(experimentId);
        logger.info(
          { experimentId, outcome: evaluation.outcome, confidence: evaluation.confidence, created },
          "experiment-worker.evaluated",
        );
        return { experimentId, outcome: evaluation.outcome, created };
      }

      default:
        logger.warn({ jobId: job.id, name: job.name }, "experiment-worker.unknown_job");
        return { skipped: true };
    }
  };
}
