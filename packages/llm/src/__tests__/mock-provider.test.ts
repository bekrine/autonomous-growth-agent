import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockLLMProvider } from "../providers/mock-provider.js";
import { createLLMProvider } from "../factory.js";

describe("MockLLMProvider", () => {
  it("returns a deterministic mock response", async () => {
    const provider = new MockLLMProvider();
    const result = await provider.generateText({ prompt: "hello" });
    expect(result.model).toBe("mock-model");
    expect(result.text).toContain("mock response");
  });

  it("fakes a schema-valid structured response", async () => {
    const provider = new MockLLMProvider();
    const schema = z.object({
      topics: z.array(
        z.object({
          topic: z.string(),
          relevanceScore: z.number().min(0).max(1),
        }),
      ),
    });
    const result = await provider.generateStructured({
      systemPrompt: "sys",
      prompt: "user",
      schema,
      schemaName: "test",
    });
    expect(() => schema.parse(result)).not.toThrow();
    expect(result.topics.length).toBeGreaterThan(0);
    expect(result.topics[0].relevanceScore).toBeGreaterThanOrEqual(0);
    expect(result.topics[0].relevanceScore).toBeLessThanOrEqual(1);
  });
});

describe("createLLMProvider", () => {
  it("falls back to the mock provider when no API key is set", () => {
    const provider = createLLMProvider({});
    expect(provider.name).toBe("mock");
  });
});
