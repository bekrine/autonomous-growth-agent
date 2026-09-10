import { describe, expect, it } from "vitest";
import { LLMValidationError, type LLMProvider, type StructuredGenerationInput } from "@agent/llm";
import { ReviewerAgent } from "../agents/reviewer-agent.js";
import { MissingContentGenerationContextError } from "../errors.js";
import { createTestContext } from "./test-context.js";
import type { ReviewResult } from "../prompts/reviewer/index.js";

class StubReviewLLM implements LLMProvider {
  readonly name = "stub";
  constructor(private readonly response: ReviewResult) {}
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

const approvedReview: ReviewResult = {
  approved: true,
  score: 0.9,
  qualityScore: 0.9,
  brandScore: 0.9,
  safetyScore: 1,
  issues: [],
  warnings: [],
  recommendedChanges: [],
};

const rejectedReview: ReviewResult = {
  approved: false,
  score: 0.4,
  qualityScore: 0.4,
  brandScore: 0.6,
  safetyScore: 1,
  issues: [{ type: "quality", message: "The hook is too generic." }],
  warnings: [],
  recommendedChanges: ["Use a more specific developer pain point."],
};

const generatedContentResult = {
  decisions: [],
  actions: [],
  data: { generatedContent: { format: "text", hook: "h", title: "t", body: "b", caption: "c", callToAction: "cta", keywords: [], altText: "a", contentWarnings: [], generationNotes: "" } },
};

describe("ReviewerAgent", () => {
  it("throws when there is no generated content to review", async () => {
    const agent = new ReviewerAgent();
    const context = createTestContext({ previousResults: {} });
    await expect(agent.run(context)).rejects.toBeInstanceOf(MissingContentGenerationContextError);
  });

  it("accepts approved content", async () => {
    const agent = new ReviewerAgent();
    const context = createTestContext(
      { previousResults: { content_creator: generatedContentResult } },
      new StubReviewLLM(approvedReview),
    );
    const result = await agent.run(context);
    expect(result.decisions[0].decision).toBe("content_approved");
    expect((result.data?.review as ReviewResult).approved).toBe(true);
  });

  it("rejects poor content with actionable recommended changes", async () => {
    const agent = new ReviewerAgent();
    const context = createTestContext(
      { previousResults: { content_creator: generatedContentResult } },
      new StubReviewLLM(rejectedReview),
    );
    const result = await agent.run(context);
    expect(result.decisions[0].decision).toBe("content_rejected");
    const review = result.data?.review as ReviewResult;
    expect(review.approved).toBe(false);
    expect(review.recommendedChanges.length).toBeGreaterThan(0);
  });

  it("rejects on a safety failure", async () => {
    const agent = new ReviewerAgent();
    const unsafeReview: ReviewResult = { ...rejectedReview, safetyScore: 0, issues: [{ type: "safety", message: "unsafe claim" }] };
    const context = createTestContext(
      { previousResults: { content_creator: generatedContentResult } },
      new StubReviewLLM(unsafeReview),
    );
    const result = await agent.run(context);
    expect((result.data?.review as ReviewResult).approved).toBe(false);
  });

  it("propagates an LLM validation failure", async () => {
    const agent = new ReviewerAgent();
    const context = createTestContext(
      { previousResults: { content_creator: generatedContentResult } },
      new FailingLLMProvider(),
    );
    await expect(agent.run(context)).rejects.toBeInstanceOf(LLMValidationError);
  });
});
