import { Worker, type Job } from "bullmq";
import { createLogger, createRedisConnection, loadEnv } from "@agent/shared";

/**
 * Placeholder processor. Real implementation will load the publishing_job
 * + content_post rows, call the appropriate SocialPlatform adapter through
 * the policy layer, and update job/post status with retry/backoff.
 */
async function processPublishingJob(job: Job, logger: ReturnType<typeof createLogger>) {
  logger.info({ jobId: job.id, data: job.data }, "publishing-worker.job_received");
  return { processed: true };
}

async function main() {
  const env = loadEnv();
  const logger = createLogger({ name: "publishing-worker" });
  const connection = createRedisConnection(env.REDIS_URL);

  const worker = new Worker("publishing", (job) => processPublishingJob(job, logger), { connection });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "publishing-worker.job_failed");
  });

  logger.info("publishing-worker.started");

  async function shutdown(signal: string) {
    logger.info({ signal }, "publishing-worker.shutting_down");
    await worker.close();
    await connection.quit();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start publishing-worker:", error);
  process.exit(1);
});
