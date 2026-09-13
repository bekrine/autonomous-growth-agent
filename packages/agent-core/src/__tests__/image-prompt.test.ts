import { describe, expect, it } from "vitest";
import { buildImagePrompt } from "../tools/generate-image.js";

/**
 * Regression: an Agnes-generated post came back with garbled lettering
 * ("create atructudn, form JWTT authenticication") because the content agent
 * asked for text inside the image. Diffusion models cannot render words
 * reliably, and gibberish on a published post reads as an unchecked mistake.
 */
describe("buildImagePrompt", () => {
  it("always forbids text, so the model is not asked to do what it cannot", () => {
    const prompt = buildImagePrompt("A developer at a laptop");
    expect(prompt).toContain("no text");
    expect(prompt).toContain("no letters");
    expect(prompt).toContain("no watermarks");
  });

  it("strips explicit requests to render words", () => {
    const prompt = buildImagePrompt(
      "Split screen showing the text 'generate code for login' on the left and a happy developer on the right",
    );
    expect(prompt).not.toContain("generate code for login");
    expect(prompt).toContain("Split screen");
    expect(prompt).toContain("happy developer");
  });

  it("keeps the visual idea intact", () => {
    const prompt = buildImagePrompt("A laptop with cyan accents on a dark navy background");
    expect(prompt).toContain("laptop");
    expect(prompt).toContain("dark navy background");
  });

  it("collapses the whitespace left behind by stripping", () => {
    expect(buildImagePrompt("A cat with the caption 'hello' sitting down")).not.toMatch(/\s{2,}/);
  });
});
