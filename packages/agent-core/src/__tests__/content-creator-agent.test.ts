import { describe, expect, it } from "vitest";
import { MockLLMProvider, LLMValidationError, type LLMProvider, type StructuredGenerationInput } from "@agent/llm";
import { ContentCreatorAgent } from "../agents/content-creator-agent.js";
import { MissingContentGenerationContextError } from "../errors.js";
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

const baseIdea = {
  id: "idea-1",
  title: "3 AI tools that save developers hours",
  contentPillar: "AI tools",
  targetAudience: "junior developers",
  hook: "You're probably wasting time doing these three things manually.",
  objective: "shares",
};

describe("ContentCreatorAgent", () => {
  it("throws when context.targetContentIdea is missing", async () => {
    const agent = new ContentCreatorAgent();
    const context = createTestContext({ targetContentIdea: null });
    await expect(agent.run(context)).rejects.toBeInstanceOf(MissingContentGenerationContextError);
  });

  it("produces schema-valid content for the reel format", async () => {
    const agent = new ContentCreatorAgent();
    const context = createTestContext({ targetContentIdea: { ...baseIdea, format: "reel" } });
    const result = await agent.run(context);

    const generated = result.data?.generatedContent as { format: string };
    expect(generated.format).toBe("reel");
    expect(result.decisions[0].decision).toBe("content_generated");
  });

  it("produces schema-valid content for the carousel format", async () => {
    const agent = new ContentCreatorAgent();
    const context = createTestContext({ targetContentIdea: { ...baseIdea, format: "carousel" } });
    const result = await agent.run(context);

    const generated = result.data?.generatedContent as { format: string };
    expect(generated.format).toBe("carousel");
  });

  it("falls back to the image format for an unrecognized idea format", async () => {
    const agent = new ContentCreatorAgent();
    const context = createTestContext({ targetContentIdea: { ...baseIdea, format: "not-a-real-format" } });
    const result = await agent.run(context);

    const generated = result.data?.generatedContent as { format: string };
    expect(generated.format).toBe("image");
  });

  it("reflects the account's niche/audience in the prompt sent to the model", async () => {
    let capturedPrompt = "";
    class RecordingLLM extends MockLLMProvider {
      override async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
        capturedPrompt = input.prompt;
        return super.generateStructured(input);
      }
    }
    const agent = new ContentCreatorAgent();
    const context = createTestContext(
      { account: { id: "a", platform: "instagram", displayName: "d", niche: "distinctive-niche-value", targetAudience: "distinctive-audience", tone: null }, targetContentIdea: { ...baseIdea, format: "text" } },
      new RecordingLLM(),
    );
    await agent.run(context);
    expect(capturedPrompt).toContain("distinctive-niche-value");
    expect(capturedPrompt).toContain("distinctive-audience");
  });

  it("propagates an LLM validation failure", async () => {
    const agent = new ContentCreatorAgent();
    const context = createTestContext({ targetContentIdea: { ...baseIdea, format: "image" } }, new FailingLLMProvider());
    await expect(agent.run(context)).rejects.toBeInstanceOf(LLMValidationError);
  });
});
