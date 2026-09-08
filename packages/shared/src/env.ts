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

  INSTAGRAM_CLIENT_ID: z.string().optional().default(""),
  INSTAGRAM_CLIENT_SECRET: z.string().optional().default(""),

  FACEBOOK_APP_ID: z.string().optional().default(""),
  FACEBOOK_APP_SECRET: z.string().optional().default(""),

  STORAGE_ENDPOINT: z.string().optional().default(""),
  STORAGE_BUCKET: z.string().optional().default(""),
  STORAGE_ACCESS_KEY: z.string().optional().default(""),
  STORAGE_SECRET_KEY: z.string().optional().default(""),

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
