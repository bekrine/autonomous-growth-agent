import { describe, expect, it } from "vitest";
import { LLMValidationError, type LLMProvider, type StructuredGenerationInput } from "@agent/llm";
import { StrategyAgent } from "../agents/strategy-agent.js";
import { createTestContext } from "./test-context.js";
import type { StrategyResult } from "../prompts/strategy.prompt.js";

class StubStrategyLLM implements LLMProvider {
  readonly name = "stub";
  constructor(private readonly response: StrategyResult) {}
  async generateText(): Promise<never> {
    throw new Error("not used");
  }
  async generateStructured<T>(_input: StructuredGenerationInput<T>): Promise<T> {
    return this.response as unknown as T;
  }
}

class FailingLLMProvider implements LLMProvider {
  readonly name = "failing";
  async generateText(): Promise<never> {
    throw new Error("not used");
  }
  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    throw new LLMValidationError(input.schemaName, 3);
  }
}

const baseStrategyResponse: StrategyResult = {
  shouldUpdateStrategy: false,
  audience: "test audience",
  positioning: "test positioning",
  contentPillars: [{ name: "pillar-a", weight: 1 }],
  formats: { reel: 1 },
  postingFrequencyPerWeek: 3,
  reasoningSummary: "no meaningful change in the evidence",
  confidence: 0.6,
};

describe("StrategyAgent", () => {
  it("forces an initial version when there is no current strategy, even if the model says no change", async () => {
    const agent = new StrategyAgent();
    const context = createTestContext({ currentStrategy: null }, new StubStrategyLLM(baseStrategyResponse));

    const result = await agent.run(context);

    expect(result.data?.shouldUpdateStrategy).toBe(true);
    expect(result.decisions[0].decision).toBe("strategy_updated");
    expect(result.decisions[0].metadata?.forcedInitialVersion).toBe(true);
  });

  it("preserves the existing strategy when the model finds no justified change", async () => {
    const agent = new StrategyAgent();
    const context = createTestContext(
      {
        currentStrategy: { strategyId: "s1", versionId: "v1", versionNumber: 2, summary: "existing", data: {} },
      },
      new StubStrategyLLM(baseStrategyResponse),
    );

    const result = await agent.run(context);

    expect(result.data?.shouldUpdateStrategy).toBe(false);
    expect(result.decisions[0].decision).toBe("strategy_unchanged");
  });

  it("updates the strategy when the model justifies a change against an existing strategy", async () => {
    const agent = new StrategyAgent();
    const context = createTestContext(
      {
        currentStrategy: { strategyId: "s1", versionId: "v1", versionNumber: 2, summary: "existing", data: {} },
      },
      new StubStrategyLLM({ ...baseStrategyResponse, shouldUpdateStrategy: true, reasoningSummary: "research justifies a pivot" }),
    );

    const result = await agent.run(context);

    expect(result.data?.shouldUpdateStrategy).toBe(true);
    expect(result.decisions[0].metadata?.forcedInitialVersion).toBe(false);
  });

  it("propagates an LLM validation failure", async () => {
    const agent = new StrategyAgent();
    const context = createTestContext({}, new FailingLLMProvider());

    await expect(agent.run(context)).rejects.toBeInstanceOf(LLMValidationError);
  });
});
