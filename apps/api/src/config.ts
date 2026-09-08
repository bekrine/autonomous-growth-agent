import { createDatabase, type Database } from "@agent/database";
import { createLLMProvider, type LLMProvider } from "@agent/llm";
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

export interface AppDependencies {
  env: AppEnv;
  logger: Logger;
  db: Database;
  redis: RedisConnection;
  llm: LLMProvider;
  agentSystem: ReturnType<typeof buildAgentSystem>;
  agentQueueProducer: AgentQueueProducer;
}

/** Builds every dependency the API needs, once, at process startup. */
export function createAppDependencies(): AppDependencies {
  const env = loadEnv();
  const logger = createLogger({ name: "api" });
  const db = createDatabase(env.DATABASE_URL);
  const redis = createRedisConnection(env.REDIS_URL);
  const llm = createLLMProvider({
    openaiApiKey: env.OPENAI_API_KEY,
    model: env.LLM_MODEL,
    maxRetries: env.LLM_MAX_RETRIES,
    logger,
  });
  const agentSystem = buildAgentSystem({ db, llm, logger });
  // A separate connection from the health-check `redis` client so the
  // producer's lifecycle (and BullMQ's own command usage) never races
  // with the plain PING used for /api/health.
  const agentQueueProducer = new AgentQueueProducer(createRedisConnection(env.REDIS_URL));

  if (env.AUTONOMY_KILL_SWITCH) {
    agentSystem.killSwitch.setGlobalDisabled(true);
    logger.warn("autonomy.kill_switch_enabled_at_startup");
  }

  return { env, logger, db, redis, llm, agentSystem, agentQueueProducer };
}
