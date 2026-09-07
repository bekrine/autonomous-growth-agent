import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../env.js";

describe("loadEnv", () => {
  it("parses a valid environment", () => {
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: "postgresql://localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
    });
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(4000);
    expect(env.AUTONOMY_KILL_SWITCH).toBe(false);
  });

  it("throws when required variables are missing", () => {
    resetEnvCache();
    expect(() => loadEnv({})).toThrow(/Invalid environment configuration/);
  });
});
