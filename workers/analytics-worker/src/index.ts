import { Queue, Worker } from "bullmq";
import { closeDatabase, createDatabase } from "@agent/database";
import { createLLMProvider } from "@agent/llm";
import { createImageGenerator, createObjectStorage } from "@agent/media";
import { buildAgentSystem, parseCollectionWindows } from "@agent/agent-core";
import {
  COLLECT_ANALYTICS_JOB_NAME,
  createLogger,
  createRedisConnection,
  loadEnv,
  TokenEncryptionService,
} from "@agent/shared";
import { createAnalyticsProcessor } from "./analytics-processor.js";

async function main() {
  const env = loadEnv();
  const logger = createLogger({ name: "analytics-worker" });
  const connection = createRedisConnection(env.REDIS_URL);
  const db = createDatabase(env.DATABASE_URL);

  const tokenEncryption = TokenEncryptionService.isConfigured(env.TOKEN_ENCRYPTION_KEY)
    ? new TokenEncryptionService(env.TOKEN_ENCRYPTION_KEY)
    : null;

  // Constructed exactly like the API's system, so analytics collected by the
  // worker and analytics requested through the API go through one service
  // with one configuration.
  const agentSystem = buildAgentSystem({
    db,
    llm: createLLMProvider({
      huggingFaceApiKey: env.HF_TOKEN,
      huggingFaceModel: env.HF_TEXT_MODEL,
      openaiApiKey: env.OPENAI_API_KEY,
      model: env.LLM_MODEL,
      maxRetries: env.LLM_MAX_RETRIES,
      logger,
    }),
    logger,
    imageGenerator: createImageGenerator({
      huggingFaceApiKey: env.HF_TOKEN,
      huggingFaceModel: env.HF_IMAGE_MODEL,
      huggingFaceProvider: env.HF_IMAGE_PROVIDER,
      agnesApiKey: env.AGNES_API_KEY,
      agnesImageModel: env.AGNES_IMAGE_MODEL,
      agnesBaseUrl: env.AGNES_BASE_URL,
      imageGenerationEnabled: env.IMAGE_GENERATION_ENABLED,
    }),
    objectStorage: createObjectStorage({
      localDir: env.STORAGE_LOCAL_DIR,
      publicBaseUrl: env.PUBLIC_MEDIA_BASE_URL,
      r2: {
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET_NAME,
        publicBaseUrl: env.R2_PUBLIC_BASE_URL,
      },
    }),
    instagramPublishingEnabled: env.INSTAGRAM_PUBLISHING_ENABLED,
    metaApiVersion: env.META_API_VERSION,
    metaGraphHost: env.META_GRAPH_HOST,
    tokenEncryption,
    analyticsCollectionWindows: parseCollectionWindows(env.ANALYTICS_COLLECTION_WINDOWS),
    analyticsBaselinePostCount: env.ANALYTICS_BASELINE_POST_COUNT,
    analyticsMaxCollectionAttempts: env.ANALYTICS_MAX_COLLECTION_ATTEMPTS,
  });

  const worker = new Worker("analytics", createAnalyticsProcessor(agentSystem.analyticsService, logger), {
    connection,
    // Deliberately low: analytics must never be able to storm the Meta API.
    concurrency: env.ANALYTICS_CONCURRENCY,
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "analytics-worker.job_failed");
  });

  /**
   * Repeatable sweep. BullMQ owns the schedule — not setInterval — so the
   * cadence survives a restart and there is exactly one scheduler even with
   * several worker replicas. The sweep itself only touches posts whose window
   * is genuinely due, which is what keeps API usage bounded.
   */
  const queue = new Queue("analytics", { connection });
  if (env.ANALYTICS_ENABLED) {
    await queue.add(
      COLLECT_ANALYTICS_JOB_NAME,
      {},
      {
        repeat: { every: env.ANALYTICS_SWEEP_INTERVAL_MINUTES * 60_000 },
        // Stable id: re-registering on every boot updates the schedule
        // instead of stacking up duplicate repeatables.
        jobId: "analytics-sweep",
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    );
  }

  logger.info(
    {
      analyticsEnabled: env.ANALYTICS_ENABLED,
      sweepIntervalMinutes: env.ANALYTICS_SWEEP_INTERVAL_MINUTES,
      concurrency: env.ANALYTICS_CONCURRENCY,
      collectionWindows: env.ANALYTICS_COLLECTION_WINDOWS,
      providerConfigured: agentSystem.analyticsProvider !== null,
    },
    "analytics-worker.started",
  );

  async function shutdown(signal: string) {
    logger.info({ signal }, "analytics-worker.shutting_down");
    await worker.close();
    await queue.close();
    await closeDatabase();
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
