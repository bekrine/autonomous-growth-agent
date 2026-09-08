import { Worker } from "bullmq";
import { createDatabase, closeDatabase, OutboxRepository } from "@agent/database";
import { createLLMProvider } from "@agent/llm";
import { buildAgentSystem } from "@agent/agent-core";
import { createLogger, createRedisConnection, loadEnv } from "@agent/shared";
import { createPlaceholderProcessor } from "./processors.js";
import { createAgentRunProcessor } from "./agent-run-processor.js";
import { OutboxPublisher } from "./outbox-publisher.js";

const PLACEHOLDER_QUEUES = ["research", "strategy", "content", "experiments"] as const;

async function main() {
  const env = loadEnv();
  const logger = createLogger({ name: "agent-worker" });
  const connection = createRedisConnection(env.REDIS_URL);
  const db = createDatabase(env.DATABASE_URL);
  const llm = createLLMProvider({
    openaiApiKey: env.OPENAI_API_KEY,
    model: env.LLM_MODEL,
    maxRetries: env.LLM_MAX_RETRIES,
    logger,
  });
  const agentSystem = buildAgentSystem({ db, llm, logger });

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

  const workers = [...placeholderWorkers, agentRunWorker];
  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      logger.error({ queue: worker.name, jobId: job?.id, err: err.message }, "worker.job_failed");
    });
  }

  logger.info({ queues: [...PLACEHOLDER_QUEUES, "agent-run"] }, "agent-worker.started");

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
