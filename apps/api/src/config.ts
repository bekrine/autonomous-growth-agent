import { createDatabase, type Database } from "@agent/database";
import { createLLMProvider, type LLMProvider } from "@agent/llm";
import { createImageGenerator, createObjectStorage } from "@agent/media";
import {
  createLogger,
  createRedisConnection,
  loadEnv,
  TokenEncryptionService,
  type AppEnv,
  type Logger,
  type RedisConnection,
} from "@agent/shared";
import { buildAgentSystem } from "@agent/agent-core";
import { AgentQueueProducer } from "./services/agent-queue-producer.js";
import { ContentQueueProducer } from "./services/content-queue-producer.js";
import { PublishingQueueProducer } from "./services/publishing-queue-producer.js";
import { InstagramAuthService } from "./services/instagram-auth.service.js";

export interface AppDependencies {
  env: AppEnv;
  logger: Logger;
  db: Database;
  redis: RedisConnection;
  llm: LLMProvider;
  agentSystem: ReturnType<typeof buildAgentSystem>;
  agentQueueProducer: AgentQueueProducer;
  contentQueueProducer: ContentQueueProducer;
  publishingQueueProducer: PublishingQueueProducer;
  instagramAuthService: InstagramAuthService;
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
  // Optional: without it the app still boots, but publishing and OAuth fail
  // closed with a clear "not configured" error rather than storing plaintext.
  const tokenEncryption = TokenEncryptionService.isConfigured(env.TOKEN_ENCRYPTION_KEY)
    ? new TokenEncryptionService(env.TOKEN_ENCRYPTION_KEY)
    : null;

  const agentSystem = buildAgentSystem({
    db,
    llm,
    logger,
    imageGenerator,
    objectStorage,
    maxRegenerationAttempts: env.MAX_CONTENT_GENERATION_ATTEMPTS,
    maxDailyMediaGenerations: env.MAX_DAILY_MEDIA_GENERATIONS,
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

  const instagramAuthService = new InstagramAuthService({
    config: {
      appId: env.META_APP_ID,
      appSecret: env.META_APP_SECRET,
      redirectUri: env.META_REDIRECT_URI,
      apiVersion: env.META_API_VERSION,
      graphHost: env.META_GRAPH_HOST,
    },
    socialConnectionRepository: agentSystem.repositories.socialConnectionRepository,
    socialAccountRepository: agentSystem.repositories.socialAccountRepository,
    tokenEncryption,
    logger,
  });

  // Separate connections from the health-check `redis` client so producer
  // lifecycles (and BullMQ's own command usage) never race with the plain
  // PING used for /api/health.
  const agentQueueProducer = new AgentQueueProducer(createRedisConnection(env.REDIS_URL));
  const contentQueueProducer = new ContentQueueProducer(createRedisConnection(env.REDIS_URL));
  const publishingQueueProducer = new PublishingQueueProducer(createRedisConnection(env.REDIS_URL));

  if (env.AUTONOMY_KILL_SWITCH) {
    agentSystem.killSwitch.setGlobalDisabled(true);
    logger.warn("autonomy.kill_switch_enabled_at_startup");
  }
  if (env.INSTAGRAM_PUBLISHING_ENABLED && !tokenEncryption) {
    logger.warn("publishing.encryption_key_missing_publishing_will_fail");
  }

  return {
    env,
    logger,
    db,
    redis,
    llm,
    agentSystem,
    agentQueueProducer,
    contentQueueProducer,
    publishingQueueProducer,
    instagramAuthService,
  };
}
