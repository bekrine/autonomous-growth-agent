import { describe, expect, it, vi } from "vitest";
import { AgentOrchestrator } from "../orchestrator.js";
import type { Agent, AgentContext, AgentResult } from "../types.js";
import { createLogger } from "@agent/shared";
import { MockLLMProvider } from "@agent/llm";
import { ToolRouter } from "../tool-router.js";
import { PolicyEngine } from "@agent/policies";

class StubAgent implements Agent {
  constructor(
    public readonly name: Agent["name"],
    private readonly result: AgentResult,
  ) {}

  async run(_context: AgentContext): Promise<AgentResult> {
    return this.result;
  }
}

function createFakeAgentRunRepository() {
  const decisions: unknown[] = [];
  const actions: unknown[] = [];
  return {
    create: vi.fn(async (accountId: string) => ({ id: "run-1", socialAccountId: accountId, status: "pending" })),
    markRunning: vi.fn(async () => ({})),
    markFinished: vi.fn(async () => ({})),
    recordDecision: vi.fn(async (input: Record<string, unknown>) => {
      decisions.push(input);
      return { id: `decision-${decisions.length}`, ...input };
    }),
    recordAction: vi.fn(async (input: Record<string, unknown>) => {
      actions.push(input);
      return { id: `action-${actions.length}`, ...input };
    }),
    decisions,
    actions,
  };
}

describe("AgentOrchestrator", () => {
  it("runs every agent in order and persists decisions/actions", async () => {
    const repo = createFakeAgentRunRepository();
    const toolRouter = new ToolRouter([], new PolicyEngine([]));
    const orchestrator = new AgentOrchestrator(
      {
        // @ts-expect-error - partial fake repository, sufficient for this test
        agentRunRepository: repo,
        toolRouter,
        llm: new MockLLMProvider(),
        logger: createLogger({ name: "test", level: "silent" }),
      },
      [
        new StubAgent("research", { decisions: [{ decision: "d1" }], actions: [{ actionType: "a1", status: "succeeded" }] }),
        new StubAgent("strategy", { decisions: [{ decision: "d2" }], actions: [] }),
      ],
    );

    const outcome = await orchestrator.executeRun("account-1");

    expect(outcome.status).toBe("completed");
    expect(repo.recordDecision).toHaveBeenCalledTimes(2);
    expect(repo.recordAction).toHaveBeenCalledTimes(1);
    expect(repo.markFinished).toHaveBeenCalledWith("run-1", "completed");
  });

  it("marks the run failed when an agent throws", async () => {
    const repo = createFakeAgentRunRepository();
    const toolRouter = new ToolRouter([], new PolicyEngine([]));

    class ThrowingAgent implements Agent {
      readonly name = "research" as const;
      async run(): Promise<AgentResult> {
        throw new Error("boom");
      }
    }

    const orchestrator = new AgentOrchestrator(
      {
        // @ts-expect-error - partial fake repository, sufficient for this test
        agentRunRepository: repo,
        toolRouter,
        llm: new MockLLMProvider(),
        logger: createLogger({ name: "test", level: "silent" }),
      },
      [new ThrowingAgent()],
    );

    const outcome = await orchestrator.executeRun("account-1");
    expect(outcome.status).toBe("failed");
    expect(repo.markFinished).toHaveBeenCalledWith("run-1", "failed", "boom");
  });
});
