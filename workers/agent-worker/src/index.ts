import { Worker } from "bullmq";
import { createDatabase, closeDatabase, OutboxRepository } from "@agent/database";
import { createLLMProvider } from "@agent/llm";
import { createImageGenerator, createObjectStorage, createVideoGenerator } from "@agent/media";
import { buildAgentSystem } from "@agent/agent-core";
import { createLogger, createRedisConnection, loadEnv } from "@agent/shared";
import { createPlaceholderProcessor } from "./processors.js";
import { createExperimentProcessor } from "./experiment-processor.js";
import { createAgentRunProcessor } from "./agent-run-processor.js";
import { createContentGenerationProcessor } from "./content-generation-processor.js";
import { OutboxPublisher } from "./outbox-publisher.js";

const PLACEHOLDER_QUEUES = ["research", "strategy"] as const;

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
    agnesApiKey: env.AGNES_API_KEY,
    agnesImageModel: env.AGNES_IMAGE_MODEL,
    agnesBaseUrl: env.AGNES_BASE_URL,
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
    experimentLimits: {
      minSamplesPerVariant: env.EXPERIMENT_MIN_SAMPLES_PER_VARIANT,
      minRelativeLift: env.EXPERIMENT_MIN_RELATIVE_LIFT,
      observationWindowHours: env.EXPERIMENT_OBSERVATION_WINDOW_HOURS,
      maxDurationDays: env.EXPERIMENT_MAX_DURATION_DAYS,
      maxActiveExperimentsPerAccount: env.MAX_ACTIVE_EXPERIMENTS_PER_ACCOUNT,
      maxExperimentContentPerDay: env.MAX_EXPERIMENT_CONTENT_PER_DAY,
      maxSampleImbalanceRatio: env.EXPERIMENT_MAX_SAMPLE_IMBALANCE_RATIO,
    },
    videoGenerator: createVideoGenerator({
      agnesApiKey: env.AGNES_API_KEY,
      agnesVideoModel: env.AGNES_VIDEO_MODEL,
      agnesBaseUrl: env.AGNES_BASE_URL,
      videoGenerationEnabled: env.VIDEO_GENERATION_ENABLED,
    }),
    videoGenerationEnabled: env.VIDEO_GENERATION_ENABLED,
    maxRegenerationAttempts: env.MAX_CONTENT_GENERATION_ATTEMPTS,
    maxDailyMediaGenerations: env.MAX_DAILY_MEDIA_GENERATIONS,
  });

  const outboxPublisher = new OutboxPublisher(new OutboxRepository(db), connection, logger);
  outboxPublisher.start();

  const placeholderWorkers = PLACEHOLDER_QUEUES.map(
    (queueName) => new Worker(queueName, createPlaceholderProcessor(queueName, logger), { connection }),
  );

  // The experiments queue is real as of Phase 6. Concurrency 1: evaluation
  // reads analytics and writes a verdict, and two concurrent evaluations of the
  // same experiment would race for the same idempotency key.
  const experimentWorker = new Worker(
    "experiments",
    createExperimentProcessor(agentSystem.experimentService, logger),
    { connection, concurrency: 1 },
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

  const workers = [...placeholderWorkers, agentRunWorker, contentWorker, experimentWorker];
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
