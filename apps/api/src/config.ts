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

export interface AppDependencies {
  env: AppEnv;
  logger: Logger;
  db: Database;
  redis: RedisConnection;
  llm: LLMProvider;
  agentSystem: ReturnType<typeof buildAgentSystem>;
}

/** Builds every dependency the API needs, once, at process startup. */
export function createAppDependencies(): AppDependencies {
  const env = loadEnv();
  const logger = createLogger({ name: "api" });
  const db = createDatabase(env.DATABASE_URL);
  const redis = createRedisConnection(env.REDIS_URL);
  const llm = createLLMProvider({ openaiApiKey: env.OPENAI_API_KEY });
  const agentSystem = buildAgentSystem({ db, llm, logger });

  if (env.AUTONOMY_KILL_SWITCH) {
    agentSystem.killSwitch.setGlobalDisabled(true);
    logger.warn("autonomy.kill_switch_enabled_at_startup");
  }

  return { env, logger, db, redis, llm, agentSystem };
}
