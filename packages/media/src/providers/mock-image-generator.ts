import type { ImageGenerationInput, ImageGenerationResult, ImageGenerator } from "../image-generator.js";

const WIDTH = 1080;
const HEIGHT = 1080;
/** At font-size 20 in a sans-serif face, ~52 characters is about as wide as 1080px allows. */
const MAX_CHARS_PER_LINE = 52;
const MAX_LINES = 5;

function escapeXml(value: string): string {
  return value.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}

/** Greedy word wrap; a single word longer than the limit is hard-split rather than allowed to overflow. */
function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > maxChars) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += maxChars) lines.push(word.slice(i, i + maxChars));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) lines.push(current);
  return lines;
}

/**
 * Deterministic placeholder used in tests and local development when no
 * image-generation key is configured. Renders the prompt as visible text
 * inside a plain SVG so it's obvious — including in the UI — that this is
 * a simulated asset, never presented as real AI output.
 */
export class MockImageGenerator implements ImageGenerator {
  readonly name = "mock";

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    // A single <text> element does not wrap, so a long prompt would run off
    // the canvas. Split it into lines that fit instead.
    const lines = wrapText(input.prompt.slice(0, 220), MAX_CHARS_PER_LINE).slice(0, MAX_LINES);
    const firstLineY = 55; // percent
    const promptLines = lines
      .map(
        (line, i) =>
          `<text x="50%" y="${firstLineY + i * 4}%" fill="#8b93a3" font-family="sans-serif" font-size="20" text-anchor="middle">${escapeXml(line)}</text>`,
      )
      .join("");

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`,
      `<rect width="100%" height="100%" fill="#1f2530"/>`,
      `<text x="50%" y="45%" fill="#5b6472" font-family="sans-serif" font-size="28" text-anchor="middle">MOCK IMAGE (not AI-generated)</text>`,
      promptLines,
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
