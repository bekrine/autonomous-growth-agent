import { Worker } from "bullmq";
import { closeDatabase, createDatabase } from "@agent/database";
import { createLLMProvider } from "@agent/llm";
import { createImageGenerator, createObjectStorage } from "@agent/media";
import { buildAgentSystem } from "@agent/agent-core";
import { createLogger, createRedisConnection, loadEnv, TokenEncryptionService } from "@agent/shared";
import { createPublishingProcessor } from "./publishing-processor.js";

async function main() {
  const env = loadEnv();
  const logger = createLogger({ name: "publishing-worker" });
  const connection = createRedisConnection(env.REDIS_URL);
  const db = createDatabase(env.DATABASE_URL);

  const tokenEncryption = TokenEncryptionService.isConfigured(env.TOKEN_ENCRYPTION_KEY)
    ? new TokenEncryptionService(env.TOKEN_ENCRYPTION_KEY)
    : null;

  // Same construction as the API, so the worker publishes through an
  // identically-configured PublishingService (same policies, same adapter).
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
    autoPublishEnabled: env.AUTO_PUBLISH_ENABLED,
    publishingLimits: {
      maxPerDay: env.MAX_POSTS_PER_DAY,
      maxPerHour: env.MAX_POSTS_PER_HOUR,
      minMinutesBetweenPosts: env.MIN_MINUTES_BETWEEN_POSTS,
    },
    maxPublishAttempts: env.MAX_PUBLISH_ATTEMPTS,
  });

  if (env.AUTONOMY_KILL_SWITCH) {
    agentSystem.killSwitch.setGlobalDisabled(true);
    logger.warn("autonomy.kill_switch_enabled_at_startup");
  }

  const worker = new Worker(
    "publishing",
    createPublishingProcessor(agentSystem.publishingService, logger),
    {
      connection,
      // One publish at a time: publishing is rate-limited and irreversible,
      // so throughput is never worth the risk of racing the limits.
      concurrency: 1,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "publishing-worker.job_failed");
  });

  logger.info(
    {
      instagramPublishingEnabled: env.INSTAGRAM_PUBLISHING_ENABLED,
      autoPublishEnabled: env.AUTO_PUBLISH_ENABLED,
      encryptionConfigured: tokenEncryption !== null,
    },
    "publishing-worker.started",
  );

  async function shutdown(signal: string) {
    logger.info({ signal }, "publishing-worker.shutting_down");
    await worker.close();
    await closeDatabase();
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
