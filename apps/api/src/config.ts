import { createDatabase, type Database } from "@agent/database";
import { createLLMProvider, type LLMProvider } from "@agent/llm";
import { createImageGenerator, createObjectStorage } from "@agent/media";
import {
  createLogger,
  createRedisConnection,
  loadEnv,
  type AppEnv,
  type Logger,
  type RedisConnection,
} from "@agent/shared";
import { buildAgentSystem } from "@agent/agent-core";
import { AgentQueueProducer } from "./services/agent-queue-producer.js";
import { ContentQueueProducer } from "./services/content-queue-producer.js";

export interface AppDependencies {
  env: AppEnv;
  logger: Logger;
  db: Database;
  redis: RedisConnection;
  llm: LLMProvider;
  agentSystem: ReturnType<typeof buildAgentSystem>;
  agentQueueProducer: AgentQueueProducer;
  contentQueueProducer: ContentQueueProducer;
}

/** Builds every dependency the API needs, once, at process startup. */
export function createAppDependencies(): AppDependencies {
  const env = loadEnv();
  const logger = createLogger({ name: "api" });
  const db = createDatabase(env.DATABASE_URL);
  const redis = createRedisConnection(env.REDIS_URL);
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
  const objectStorage = createObjectStorage({ localDir: env.STORAGE_LOCAL_DIR, publicBaseUrl: env.PUBLIC_MEDIA_BASE_URL });
  const agentSystem = buildAgentSystem({
    db,
    llm,
    logger,
    imageGenerator,
    objectStorage,
    maxRegenerationAttempts: env.MAX_CONTENT_GENERATION_ATTEMPTS,
    maxDailyMediaGenerations: env.MAX_DAILY_MEDIA_GENERATIONS,
  });
  // Separate connections from the health-check `redis` client so producer
  // lifecycles (and BullMQ's own command usage) never race with the plain
  // PING used for /api/health.
  const agentQueueProducer = new AgentQueueProducer(createRedisConnection(env.REDIS_URL));
  const contentQueueProducer = new ContentQueueProducer(createRedisConnection(env.REDIS_URL));

  if (env.AUTONOMY_KILL_SWITCH) {
    agentSystem.killSwitch.setGlobalDisabled(true);
    logger.warn("autonomy.kill_switch_enabled_at_startup");
  }

  return { env, logger, db, redis, llm, agentSystem, agentQueueProducer, contentQueueProducer };
}
