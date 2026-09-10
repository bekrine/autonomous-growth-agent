import type { ImageGenerationInput, ImageGenerationResult, ImageGenerator } from "../image-generator.js";

const WIDTH = 1080;
const HEIGHT = 1080;

/**
 * Deterministic placeholder used in tests and local development when no
 * image-generation key is configured. Renders the prompt as visible text
 * inside a plain SVG so it's obvious — including in the UI — that this is
 * a simulated asset, never presented as real AI output.
 */
export class MockImageGenerator implements ImageGenerator {
  readonly name = "mock";

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const escaped = input.prompt.slice(0, 120).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`,
      `<rect width="100%" height="100%" fill="#1f2530"/>`,
      `<text x="50%" y="45%" fill="#5b6472" font-family="sans-serif" font-size="28" text-anchor="middle">MOCK IMAGE (not AI-generated)</text>`,
      `<text x="50%" y="55%" fill="#8b93a3" font-family="sans-serif" font-size="20" text-anchor="middle">${escaped}</text>`,
      `</svg>`,
    ].join("");

    return {
      imageData: Buffer.from(svg, "utf-8"),
      mimeType: "image/svg+xml",
      provider: "mock",
      width: WIDTH,
      height: HEIGHT,
    };
  }
}
