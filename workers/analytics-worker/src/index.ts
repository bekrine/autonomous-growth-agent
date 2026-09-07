import { Worker, type Job } from "bullmq";
import { createLogger, createRedisConnection, loadEnv } from "@agent/shared";

/**
 * Placeholder processor. Real implementation will call
 * SocialPlatform.getAnalytics() for recently published posts and write
 * analytics_snapshots rows.
 */
async function processAnalyticsJob(job: Job, logger: ReturnType<typeof createLogger>) {
  logger.info({ jobId: job.id, data: job.data }, "analytics-worker.job_received");
  return { processed: true };
}

async function main() {
  const env = loadEnv();
  const logger = createLogger({ name: "analytics-worker" });
  const connection = createRedisConnection(env.REDIS_URL);

  const worker = new Worker("analytics", (job) => processAnalyticsJob(job, logger), { connection });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "analytics-worker.job_failed");
  });

  logger.info("analytics-worker.started");

  async function shutdown(signal: string) {
    logger.info({ signal }, "analytics-worker.shutting_down");
    await worker.close();
    await connection.quit();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start analytics-worker:", error);
  process.exit(1);
});
