import { z } from "zod";

/**
 * Every process (api, workers) validates its environment at startup through
 * this schema. Fail fast rather than discovering a missing var mid-request.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  OPENAI_API_KEY: z.string().optional().default(""),
  LLM_MODEL: z.string().optional().default("gpt-4o-mini"),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).optional().default(3),

  // Hugging Face Inference Providers — free-tier LLM + image generation.
  // Takes priority over OPENAI_API_KEY when set (see packages/llm/src/factory.ts).
  HF_TOKEN: z.string().optional().default(""),
  HF_TEXT_MODEL: z.string().optional().default("Qwen/Qwen3-4B-Instruct-2507"),
  HF_IMAGE_MODEL: z.string().optional().default("black-forest-labs/FLUX.1-schnell"),
  HF_IMAGE_PROVIDER: z.string().optional().default("fal-ai"),
  // Opt-in because image generation (unlike HF text generation) is not
  // free — see packages/media/src/factory.ts. Off => MockImageGenerator.
  IMAGE_GENERATION_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),

  INSTAGRAM_CLIENT_ID: z.string().optional().default(""),
  INSTAGRAM_CLIENT_SECRET: z.string().optional().default(""),

  FACEBOOK_APP_ID: z.string().optional().default(""),
  FACEBOOK_APP_SECRET: z.string().optional().default(""),

  // --- Meta / Instagram publishing (Phase 4) ---
  // All optional so the app still boots with social integration unconfigured;
  // InstagramAuthService.isConfigured() gates the OAuth routes instead.
  META_APP_ID: z.string().optional().default(""),
  META_APP_SECRET: z.string().optional().default(""),
  META_REDIRECT_URI: z.string().optional().default("http://localhost:4000/api/social/instagram/callback"),
  META_API_VERSION: z.string().optional().default("v21.0"),
  META_GRAPH_HOST: z.string().optional().default("https://graph.facebook.com"),
  /** Opt-in: without it the system uses MockInstagramAdapter and never calls Meta. */
  INSTAGRAM_PUBLISHING_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  /** 32-byte key (hex or base64) for AES-256-GCM token encryption at rest. */
  TOKEN_ENCRYPTION_KEY: z.string().optional().default(""),

  // --- Publishing safety / rate limits ---
  // Deliberately conservative: Meta allows 100/24h, we default far below so a
  // queue or retry bug can't burn the real quota.
  AUTO_PUBLISH_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  MAX_POSTS_PER_DAY: z.coerce.number().int().min(0).max(100).optional().default(5),
  MAX_POSTS_PER_HOUR: z.coerce.number().int().min(0).max(50).optional().default(2),
  MIN_MINUTES_BETWEEN_POSTS: z.coerce.number().int().min(0).optional().default(10),
  MAX_PUBLISH_ATTEMPTS: z.coerce.number().int().min(1).max(10).optional().default(3),
  /** Where the OAuth callback sends the browser after a successful connect. */
  DASHBOARD_URL: z.string().optional().default("http://localhost:3000"),

  STORAGE_ENDPOINT: z.string().optional().default(""),
  STORAGE_BUCKET: z.string().optional().default(""),
  STORAGE_ACCESS_KEY: z.string().optional().default(""),
  STORAGE_SECRET_KEY: z.string().optional().default(""),
  // Local-disk object storage — the fallback when R2 is not configured.
  STORAGE_LOCAL_DIR: z.string().optional().default("./storage"),
  PUBLIC_MEDIA_BASE_URL: z.string().optional().default("http://localhost:4000/media"),

  /**
   * Cloudflare R2 (S3-compatible). All optional so the app still boots
   * unconfigured and transparently falls back to local-disk storage; the
   * factory only selects R2 when account id, key, secret, bucket and public
   * base URL are ALL present, since a half-configured bucket would produce
   * URLs Meta cannot fetch.
   *
   * These are server-side secrets. They must never be sent to the browser,
   * logged, or embedded in an error message.
   */
  R2_ACCOUNT_ID: z.string().optional().default(""),
  R2_ACCESS_KEY_ID: z.string().optional().default(""),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(""),
  R2_BUCKET_NAME: z.string().optional().default(""),
  /** Cloudflare public development URL, e.g. https://pub-<id>.r2.dev — public by design. */
  R2_PUBLIC_BASE_URL: z.string().optional().default(""),
  /** Opt-in switch for the test that talks to the real bucket. Never enable in CI. */
  R2_INTEGRATION_TEST: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Analytics (Phase 5). Collection windows are minutes after publication;
   * the ladder is finite, which is what bounds API usage. Baseline count and
   * score weights are configuration, not business rules baked into code.
   */
  ANALYTICS_COLLECTION_WINDOWS: z.string().optional().default("60,360,1440,4320"),
  ANALYTICS_BASELINE_POST_COUNT: z.coerce.number().int().min(1).max(200).optional().default(10),
  ANALYTICS_MAX_COLLECTION_ATTEMPTS: z.coerce.number().int().min(1).max(10).optional().default(3),
  /** How often the worker sweeps for posts whose next window is due. */
  ANALYTICS_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().min(1).optional().default(15),
  /** Serial by default: analytics must never be able to storm the Meta API. */
  ANALYTICS_CONCURRENCY: z.coerce.number().int().min(1).max(10).optional().default(1),
  ANALYTICS_ENABLED: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v !== "false"),

  MAX_CONTENT_GENERATION_ATTEMPTS: z.coerce.number().int().min(1).max(10).optional().default(3),
  MAX_DAILY_MEDIA_GENERATIONS: z.coerce.number().int().min(0).optional().default(50),

  AUTONOMY_KILL_SWITCH: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

/**
 * Parses and validates process.env. Throws with a readable message listing
 * every missing/invalid variable instead of failing deep in some unrelated
 * call site later.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

/** Test-only helper to reset the memoized env between test cases. */
export function resetEnvCache(): void {
  cachedEnv = undefined;
}
