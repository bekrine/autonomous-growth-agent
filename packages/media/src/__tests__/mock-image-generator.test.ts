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

describe("MockImageGenerator text layout", () => {
  it("wraps a long prompt across lines instead of overflowing the canvas", async () => {
    const longPrompt =
      "a very long visual direction that keeps going and going well past the width of a single line so it must wrap";
    const svg = (await new MockImageGenerator().generate({ prompt: longPrompt })).imageData.toString("utf-8");

    const textLines = svg.match(/<text[^>]*font-size="20"/g) ?? [];
    expect(textLines.length).toBeGreaterThan(1);
    // Every wrapped fragment stays within the width budget.
    for (const fragment of svg.match(/font-size="20"[^>]*>([^<]*)</g) ?? []) {
      expect(fragment.split(">")[1]!.length).toBeLessThanOrEqual(52);
    }
  });

  it("escapes markup so a prompt cannot break the SVG", async () => {
    const svg = (
      await new MockImageGenerator().generate({ prompt: "<script>alert(1)</script> & more" })
    ).imageData.toString("utf-8");

    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});
