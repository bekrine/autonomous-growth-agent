import { createLogger } from "@agent/shared";
import { MockLLMProvider, type LLMProvider } from "@agent/llm";
import { PolicyEngine } from "@agent/policies";
import type { AgentContext } from "../types.js";
import { ToolRouter } from "../tool-router.js";

/** Builds a fully-populated, DB-free AgentContext for agent unit tests. */
export function createTestContext(overrides: Partial<AgentContext> = {}, llm: LLMProvider = new MockLLMProvider()): AgentContext {
  return {
    runId: "run-1",
    accountId: "account-1",
    logger: createLogger({ name: "test", level: "silent" }),
    llm,
    tools: new ToolRouter([], new PolicyEngine([])),
    previousResults: {},
    account: {
      id: "account-1",
      platform: "instagram",
      displayName: "Test Account",
      niche: "test niche",
      targetAudience: "test audience",
      tone: null,
    },
    goal: { id: "goal-1", title: "Grow followers", metric: "followers", targetValue: 10000, status: "active" },
    currentStrategy: null,
    recentContent: [],
    recentAnalytics: [],
    previousStrategyVersions: [],
    activeExperiments: [],
    research: [],
    policies: { autonomyEnabled: true, contentApprovalRequired: true },
    agentProfileId: "profile-1",
    targetContentIdea: null,
    regenerationFeedback: [],
    ...overrides,
  };
}
