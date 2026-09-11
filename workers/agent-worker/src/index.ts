import { Worker } from "bullmq";
import { createDatabase, closeDatabase, OutboxRepository } from "@agent/database";
import { createLLMProvider } from "@agent/llm";
import { createImageGenerator, createObjectStorage } from "@agent/media";
import { buildAgentSystem } from "@agent/agent-core";
import { createLogger, createRedisConnection, loadEnv } from "@agent/shared";
import { createPlaceholderProcessor } from "./processors.js";
import { createAgentRunProcessor } from "./agent-run-processor.js";
import { createContentGenerationProcessor } from "./content-generation-processor.js";
import { OutboxPublisher } from "./outbox-publisher.js";

const PLACEHOLDER_QUEUES = ["research", "strategy", "experiments"] as const;

async function main() {
  const env = loadEnv();
  const logger = createLogger({ name: "agent-worker" });
  const connection = createRedisConnection(env.REDIS_URL);
  const db = createDatabase(env.DATABASE_URL);
  const llm = createLLMProvider({
    huggingFaceApiKey: env.HF_TOKEN,
    huggingFaceModel: env.HF_TEXT_MODEL,
    openaiApiKey: env.OPENAI_API_KEY,
    model: env.LLM_MODEL,
    maxRetries: env.LLM_MAX_RETRIES,
    logger,
  });
  const imageGenerator = createImageGenerator({
    huggingFaceApiKey: env.HF_TOKEN,
    huggingFaceModel: env.HF_IMAGE_MODEL,
    huggingFaceProvider: env.HF_IMAGE_PROVIDER,
    imageGenerationEnabled: env.IMAGE_GENERATION_ENABLED,
  });
  const objectStorage = createObjectStorage({
    localDir: env.STORAGE_LOCAL_DIR,
    publicBaseUrl: env.PUBLIC_MEDIA_BASE_URL,
    r2: {
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET_NAME,
      publicBaseUrl: env.R2_PUBLIC_BASE_URL,
    },
  });
  const agentSystem = buildAgentSystem({
    db,
    llm,
    logger,
    imageGenerator,
    objectStorage,
    maxRegenerationAttempts: env.MAX_CONTENT_GENERATION_ATTEMPTS,
    maxDailyMediaGenerations: env.MAX_DAILY_MEDIA_GENERATIONS,
  });

  const outboxPublisher = new OutboxPublisher(new OutboxRepository(db), connection, logger);
  outboxPublisher.start();

  const placeholderWorkers = PLACEHOLDER_QUEUES.map(
    (queueName) => new Worker(queueName, createPlaceholderProcessor(queueName, logger), { connection }),
  );

  const agentRunWorker = new Worker(
    "agent-run",
    createAgentRunProcessor(agentSystem.agentRunService, logger),
    { connection },
  );

  // The "content" queue is real (not a placeholder): its only job type
  // today, "generate-content", drives the Phase 3 ContentCreator -> media
  // -> Reviewer pipeline via the same AgentRunService the API uses.
  const contentWorker = new Worker(
    "content",
    createContentGenerationProcessor(agentSystem.agentRunService, logger),
    { connection },
  );

  const workers = [...placeholderWorkers, agentRunWorker, contentWorker];
  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      logger.error({ queue: worker.name, jobId: job?.id, err: err.message }, "worker.job_failed");
    });
  }

  logger.info({ queues: [...PLACEHOLDER_QUEUES, "agent-run", "content"] }, "agent-worker.started");

  async function shutdown(signal: string) {
    logger.info({ signal }, "agent-worker.shutting_down");
    await outboxPublisher.stop();
    await Promise.all(workers.map((w) => w.close()));
    await closeDatabase();
    await connection.quit();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start agent-worker:", error);
  process.exit(1);
});
