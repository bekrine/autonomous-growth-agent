import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import type { AppDependencies } from "../config.js";
import { createLogger } from "@agent/shared";

function createFakeDeps(): AppDependencies {
  return {
    env: { NODE_ENV: "test", STORAGE_LOCAL_DIR: "/tmp" } as AppDependencies["env"],
    logger: createLogger({ name: "test", level: "silent" }),
    db: { execute: vi.fn(async () => undefined) } as unknown as AppDependencies["db"],
    redis: { ping: vi.fn(async () => "PONG"), quit: vi.fn() } as unknown as AppDependencies["redis"],
    llm: { name: "mock", generateText: vi.fn(), generateStructured: vi.fn() },
    agentQueueProducer: { enqueueRun: vi.fn(), close: vi.fn() } as unknown as AppDependencies["agentQueueProducer"],
    contentQueueProducer: { enqueueGeneration: vi.fn(), close: vi.fn() } as unknown as AppDependencies["contentQueueProducer"],
    publishingQueueProducer: { enqueuePublish: vi.fn(async () => ({ jobId: "pub-1" })), close: vi.fn() } as unknown as AppDependencies["publishingQueueProducer"],
    instagramAuthService: {
      isConfigured: vi.fn(() => false),
      getStatus: vi.fn(async () => ({ configured: false, connected: false })),
      listConnections: vi.fn(async () => []),
    } as unknown as AppDependencies["instagramAuthService"],
    agentSystem: {
      orchestrator: { executeRun: vi.fn() },
      agentRunService: { listRuns: vi.fn(async () => []) },
      toolRouter: {},
      policyEngine: {},
      killSwitch: { setGlobalDisabled: vi.fn() },
      repositories: {
        socialAccountRepository: { listAll: vi.fn(async () => []) },
        agentProfileRepository: {},
        strategyRepository: {},
        agentRunRepository: { listRecent: vi.fn(async () => []) },
        researchRepository: {},
        contentRepository: {},
      },
    } as unknown as AppDependencies["agentSystem"],
  };
}

describe("GET /api/health", () => {
  it("returns ok when database and redis are reachable", async () => {
    const app = createApp(createFakeDeps());
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });
});

describe("GET /api/version", () => {
  it("returns the API version", async () => {
    const app = createApp(createFakeDeps());
    const response = await request(app).get("/api/version");
    expect(response.status).toBe(200);
    expect(response.body.version).toBeDefined();
  });
});
