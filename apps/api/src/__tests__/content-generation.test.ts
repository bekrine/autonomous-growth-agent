import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import type { AppDependencies } from "../config.js";
import { createLogger } from "@agent/shared";

const IDEA_ID = "33333333-3333-3333-3333-333333333333";
const POST_ID = "44444444-4444-4444-4444-444444444444";
const ACCOUNT_ID = "55555555-5555-5555-5555-555555555555";

function createFakeDeps() {
  const agentRunService = {
    generateContent: vi.fn(async () => ({
      contentId: POST_ID,
      status: "ready_for_publishing",
      generationVersion: 1,
      generationAttempts: 1,
      generation: { generationId: "g1", version: 1, format: "reel", status: "generated", review: { approved: true, score: 0.9 } },
    })),
    getContent: vi.fn(async () => ({ contentId: POST_ID, status: "ready_for_publishing", generationVersion: 1, generation: null })),
    getContentVersions: vi.fn(async () => ({ contentPostId: POST_ID, status: "ready_for_publishing", versions: [] })),
    getLatestReview: vi.fn(async () => ({ approved: true, score: 0.9 })),
  };

  const contentRepository = {
    findIdeaById: vi.fn(async (id: string) => (id === IDEA_ID ? { id, agentProfileId: "profile-1" } : null)),
  };
  const agentProfileRepository = {
    findById: vi.fn(async (id: string) => (id === "profile-1" ? { id, socialAccountId: ACCOUNT_ID } : null)),
  };

  const deps = {
    env: { NODE_ENV: "test", STORAGE_LOCAL_DIR: "/tmp" } as AppDependencies["env"],
    logger: createLogger({ name: "test", level: "silent" }),
    db: {} as AppDependencies["db"],
    redis: {} as AppDependencies["redis"],
    llm: { name: "mock", generateText: vi.fn(), generateStructured: vi.fn() },
    agentQueueProducer: { enqueueRun: vi.fn(), close: vi.fn() } as unknown as AppDependencies["agentQueueProducer"],
    contentQueueProducer: {
      enqueueGeneration: vi.fn(async () => ({ jobId: "job-1" })),
      close: vi.fn(),
    } as unknown as AppDependencies["contentQueueProducer"],
    publishingQueueProducer: {
      enqueuePublish: vi.fn(async () => ({ jobId: "pub-1" })),
      close: vi.fn(),
    } as unknown as AppDependencies["publishingQueueProducer"],
    instagramAuthService: {
      isConfigured: vi.fn(() => false),
      getStatus: vi.fn(async () => ({ configured: false, connected: false })),
      listConnections: vi.fn(async () => []),
    } as unknown as AppDependencies["instagramAuthService"],
    agentSystem: {
      orchestrator: {},
      agentRunService,
      toolRouter: {},
      policyEngine: {},
      killSwitch: { setGlobalDisabled: vi.fn() },
      repositories: {
        socialAccountRepository: { listAll: vi.fn(async () => []) },
        agentProfileRepository,
        strategyRepository: {},
        agentRunRepository: { listRecent: vi.fn(async () => []) },
        researchRepository: {},
        contentRepository,
        contentGenerationRepository: {},
      },
    } as unknown as AppDependencies["agentSystem"],
  } as AppDependencies;

  return { deps, agentRunService, contentRepository };
}

describe("POST /api/content/:id/generate", () => {
  it("resolves the account from the idea and generates content", async () => {
    const { deps, agentRunService } = createFakeDeps();
    const app = createApp(deps);

    const response = await request(app).post(`/api/content/${IDEA_ID}/generate`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ contentId: POST_ID, status: "ready_for_publishing", generationVersion: 1 });
    expect(agentRunService.generateContent).toHaveBeenCalledWith(ACCOUNT_ID, IDEA_ID);
  });

  it("404s for an unknown idea", async () => {
    const { deps } = createFakeDeps();
    const app = createApp(deps);
    const response = await request(app).post("/api/content/66666666-6666-6666-6666-666666666666/generate");
    expect(response.status).toBe(404);
  });
});

describe("POST /api/content/:id/generate/queue", () => {
  it("enqueues a content-generation job", async () => {
    const { deps } = createFakeDeps();
    const app = createApp(deps);
    const response = await request(app).post(`/api/content/${IDEA_ID}/generate/queue`);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "queued", jobId: "job-1" });
    expect(deps.contentQueueProducer.enqueueGeneration).toHaveBeenCalledWith(ACCOUNT_ID, IDEA_ID);
  });
});

describe("GET /api/content/:id", () => {
  it("returns the current content state", async () => {
    const { deps } = createFakeDeps();
    const app = createApp(deps);
    const response = await request(app).get(`/api/content/${POST_ID}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ contentId: POST_ID, status: "ready_for_publishing" });
  });
});

describe("GET /api/content/:id/versions", () => {
  it("returns the version history", async () => {
    const { deps } = createFakeDeps();
    const app = createApp(deps);
    const response = await request(app).get(`/api/content/${POST_ID}/versions`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ contentPostId: POST_ID });
  });
});
