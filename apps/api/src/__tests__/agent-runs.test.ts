import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import type { AppDependencies } from "../config.js";
import { createLogger } from "@agent/shared";
import { AgentRunService } from "@agent/agent-core";

const KNOWN_RUN_ID = "11111111-1111-1111-1111-111111111111";

function createFakeDeps(overrides: Partial<AppDependencies["agentSystem"]> = {}): AppDependencies {
  const orchestrator = { executeRun: vi.fn(async () => ({ runId: KNOWN_RUN_ID, status: "completed" as const })) };

  const agentRunRepository = {
    listRecent: vi.fn(async () => [{ id: KNOWN_RUN_ID, status: "completed" }]),
    findById: vi.fn(async (id: string) =>
      id === KNOWN_RUN_ID ? { id, status: "completed", socialAccountId: "acc-1" } : null,
    ),
    listDecisions: vi.fn(async () => [{ id: "d1", decision: "research_topics_discovered" }]),
    listActions: vi.fn(async () => [{ id: "a1", actionType: "research_topics" }]),
  };
  const researchRepository = { listByRunId: vi.fn(async () => []) };
  const strategyRepository = {
    findVersionByRunId: vi.fn(async () => null),
    findByAgentProfileId: vi.fn(async () => []),
    latestVersion: vi.fn(async () => null),
  };
  const contentRepository = { listIdeasByRunId: vi.fn(async () => []), findIdeaById: vi.fn(async () => null) };
  const contentGenerationRepository = {
    findLatestByPostId: vi.fn(async () => null),
    listByPostId: vi.fn(async () => []),
    findReviewByGenerationId: vi.fn(async () => null),
    listAssetsByGenerationId: vi.fn(async () => []),
  };
  const agentProfileRepository = { findBySocialAccountId: vi.fn(async () => null), findById: vi.fn(async () => null) };

  // Real AgentRunService (framework-agnostic) driven by fake repos/orchestrator,
  // exactly as buildAgentSystem constructs it in production.
  const agentRunService = new AgentRunService({
    // @ts-expect-error - partial fake orchestrator, sufficient for this test
    orchestrator,
    // @ts-expect-error - partial fake repository, sufficient for this test
    agentRunRepository,
    // @ts-expect-error - partial fake repository, sufficient for this test
    researchRepository,
    // @ts-expect-error - partial fake repository, sufficient for this test
    strategyRepository,
    // @ts-expect-error - partial fake repository, sufficient for this test
    contentRepository,
    // @ts-expect-error - partial fake repository, sufficient for this test
    contentGenerationRepository,
    // @ts-expect-error - partial fake repository, sufficient for this test
    agentProfileRepository,
  });

  return {
    env: { NODE_ENV: "test", STORAGE_LOCAL_DIR: "/tmp" } as AppDependencies["env"],
    logger: createLogger({ name: "test", level: "silent" }),
    db: {} as AppDependencies["db"],
    redis: {} as AppDependencies["redis"],
    llm: { name: "mock", generateText: vi.fn(), generateStructured: vi.fn() },
    agentQueueProducer: { enqueueRun: vi.fn(async () => ({ jobId: "job-1" })), close: vi.fn() } as unknown as AppDependencies["agentQueueProducer"],
    contentQueueProducer: { enqueueGeneration: vi.fn(async () => ({ jobId: "job-2" })), close: vi.fn() } as unknown as AppDependencies["contentQueueProducer"],
    publishingQueueProducer: { enqueuePublish: vi.fn(async () => ({ jobId: "pub-1" })), close: vi.fn() } as unknown as AppDependencies["publishingQueueProducer"],
    instagramAuthService: {
      isConfigured: vi.fn(() => false),
      getStatus: vi.fn(async () => ({ configured: false, connected: false })),
      listConnections: vi.fn(async () => []),
    } as unknown as AppDependencies["instagramAuthService"],
    agentSystem: {
      orchestrator,
      agentRunService,
      toolRouter: {},
      policyEngine: {},
      killSwitch: { setGlobalDisabled: vi.fn() },
      repositories: {
        socialAccountRepository: { listAll: vi.fn(async () => []) },
        agentProfileRepository,
        strategyRepository,
        agentRunRepository,
        researchRepository,
        contentRepository,
        contentGenerationRepository,
      },
      ...overrides,
    } as unknown as AppDependencies["agentSystem"],
  };
}

describe("POST /api/agent/runs", () => {
  it("starts a run and returns the structured result", async () => {
    const deps = createFakeDeps();
    const app = createApp(deps);

    const response = await request(app)
      .post("/api/agent/runs")
      .send({ accountId: "11111111-1111-1111-1111-111111111111" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ runId: KNOWN_RUN_ID, status: "completed", research: [], contentIdeas: [] });
    expect(deps.agentSystem.orchestrator.executeRun).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
  });

  it("rejects an invalid accountId", async () => {
    const app = createApp(createFakeDeps());
    const response = await request(app).post("/api/agent/runs").send({ accountId: "not-a-uuid" });
    expect(response.status).toBe(400);
  });
});

describe("GET /api/agent/runs/:id", () => {
  it("returns the persisted run with decisions and actions", async () => {
    const app = createApp(createFakeDeps());
    const response = await request(app).get(`/api/agent/runs/${KNOWN_RUN_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ runId: KNOWN_RUN_ID, status: "completed" });
    expect(response.body.decisions).toHaveLength(1);
    expect(response.body.actions).toHaveLength(1);
  });

  it("rejects a non-UUID run id", async () => {
    const app = createApp(createFakeDeps());
    const response = await request(app).get("/api/agent/runs/not-a-uuid");
    expect(response.status).toBe(400);
  });

  it("404s for an unknown run", async () => {
    const app = createApp(createFakeDeps());
    const response = await request(app).get("/api/agent/runs/22222222-2222-2222-2222-222222222222");
    expect(response.status).toBe(404);
  });
});
