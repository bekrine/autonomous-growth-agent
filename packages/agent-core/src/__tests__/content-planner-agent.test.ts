import { describe, expect, it } from "vitest";
import { MockLLMProvider, type LLMProvider, type StructuredGenerationInput } from "@agent/llm";
import { ContentPlannerAgent } from "../agents/content-planner-agent.js";
import { createTestContext } from "./test-context.js";

class RecordingLLM implements LLMProvider {
  readonly name = "recording";
  lastPrompt = "";
  private readonly delegate = new MockLLMProvider();

  async generateText(): Promise<never> {
    throw new Error("not used");
  }
  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    this.lastPrompt = input.prompt;
    return this.delegate.generateStructured(input);
  }
}

describe("ContentPlannerAgent", () => {
  it("produces schema-valid content ideas", async () => {
    const agent = new ContentPlannerAgent();
    const context = createTestContext();
    const result = await agent.run(context);

    const ideas = result.data?.ideas as unknown[];
    expect(Array.isArray(ideas)).toBe(true);
    expect(ideas.length).toBeGreaterThan(0);
    expect(result.decisions[0].decision).toBe("content_ideas_planned");
  });

  it("grounds the prompt in the current strategy's content pillars", async () => {
    const llm = new RecordingLLM();
    const agent = new ContentPlannerAgent();
    const context = createTestContext(
      {
        previousResults: {
          strategy: {
            decisions: [],
            actions: [],
            data: {
              shouldUpdateStrategy: true,
              audience: "audience",
              positioning: "positioning",
              contentPillars: [{ name: "distinctive-pillar-name", weight: 1 }],
              formats: { reel: 1 },
              postingFrequencyPerWeek: 3,
              reasoningSummary: "",
              confidence: 0.9,
            },
          },
        },
      },
      llm,
    );

    await agent.run(context);
    expect(llm.lastPrompt).toContain("distinctive-pillar-name");
  });

  it("passes recent content titles into the prompt so the model can avoid duplicating them", async () => {
    const llm = new RecordingLLM();
    const agent = new ContentPlannerAgent();
    const context = createTestContext(
      { recentContent: [{ id: "p1", title: "already-covered-title", status: "published", format: null, contentPillar: null, createdAt: new Date().toISOString() }] },
      llm,
    );

    await agent.run(context);
    expect(llm.lastPrompt).toContain("already-covered-title");
  });
});
