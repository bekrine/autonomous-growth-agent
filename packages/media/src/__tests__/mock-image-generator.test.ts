import { describe, expect, it } from "vitest";
import { MockImageGenerator } from "../providers/mock-image-generator.js";
import { createImageGenerator } from "../factory.js";

describe("MockImageGenerator", () => {
  it("returns deterministic, clearly-labeled placeholder bytes", async () => {
    const generator = new MockImageGenerator();
    const result = await generator.generate({ prompt: "a cat coding" });
    expect(result.provider).toBe("mock");
    expect(result.mimeType).toBe("image/svg+xml");
    expect(result.imageData.toString("utf-8")).toContain("MOCK IMAGE");
    expect(result.imageData.toString("utf-8")).toContain("a cat coding");
  });
});

describe("createImageGenerator", () => {
  it("falls back to mock when no key is configured", () => {
    const generator = createImageGenerator({});
    expect(generator.name).toBe("mock");
  });

  it("stays on mock when a key is present but real generation is not enabled (it costs money)", () => {
    const generator = createImageGenerator({ huggingFaceApiKey: "hf_test" });
    expect(generator.name).toBe("mock");
  });

  it("stays on mock when enabled but no key is configured", () => {
    const generator = createImageGenerator({ imageGenerationEnabled: true });
    expect(generator.name).toBe("mock");
  });

  it("uses Hugging Face only when explicitly enabled and a key is configured", () => {
    const generator = createImageGenerator({ huggingFaceApiKey: "hf_test", imageGenerationEnabled: true });
    expect(generator.name).toBe("huggingface");
  });
});
