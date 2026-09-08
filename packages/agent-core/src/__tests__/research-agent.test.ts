import { describe, expect, it } from "vitest";
import { LLMValidationError, type LLMProvider, type StructuredGenerationInput } from "@agent/llm";
import { ResearchAgent } from "../agents/research-agent.js";
import { MockResearchProvider } from "../research/research-provider.js";
import { createTestContext } from "./test-context.js";

class FailingLLMProvider implements LLMProvider {
  readonly name = "failing";
  async generateText(): Promise<never> {
    throw new Error("not used");
  }
  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    throw new LLMValidationError(input.schemaName, 3);
  }
}

describe("ResearchAgent", () => {
  it("returns schema-valid structured topics from valid input", async () => {
    const agent = new ResearchAgent(new MockResearchProvider());
    const context = createTestContext();
    const result = await agent.run(context);

    expect(result.decisions[0].decision).toBe("research_topics_discovered");
    const data = result.data?.topics as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("handles a research provider that returns no signals without throwing", async () => {
    const emptyProvider = { name: "empty", discoverTopics: async () => [] };
    const agent = new ResearchAgent(emptyProvider);
    const context = createTestContext();
    const result = await agent.run(context);

    expect(result.decisions[0].metadata?.simulatedSource).toBe(true);
    expect(Array.isArray(result.data?.topics)).toBe(true);
  });

  it("propagates an LLM validation failure so the orchestrator can mark the run failed", async () => {
    const agent = new ResearchAgent(new MockResearchProvider());
    const context = createTestContext({}, new FailingLLMProvider());

    await expect(agent.run(context)).rejects.toBeInstanceOf(LLMValidationError);
  });

  it("marks research signals fed to the model as simulated when using the mock provider", async () => {
    const agent = new ResearchAgent(new MockResearchProvider());
    const context = createTestContext();
    const result = await agent.run(context);

    expect(result.decisions[0].metadata?.simulatedSource).toBe(true);
    expect(result.actions[0].payload).toMatchObject({ provider: "mock" });
  });
});
