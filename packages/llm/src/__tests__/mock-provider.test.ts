import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "../providers/mock-provider.js";
import { createLLMProvider } from "../factory.js";

describe("MockLLMProvider", () => {
  it("returns a deterministic mock response", async () => {
    const provider = new MockLLMProvider();
    const result = await provider.generateText({ prompt: "hello" });
    expect(result.model).toBe("mock-model");
    expect(result.text).toContain("mock response");
  });
});

describe("createLLMProvider", () => {
  it("falls back to the mock provider when no API key is set", () => {
    const provider = createLLMProvider({});
    expect(provider.name).toBe("mock");
  });
});
