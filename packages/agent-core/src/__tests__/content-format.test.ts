import { describe, expect, it } from "vitest";
import { normalizeContentFormat } from "../prompts/content-creator/schema.js";

describe("normalizeContentFormat", () => {
  it("passes through exact enum values", () => {
    expect(normalizeContentFormat("reel")).toBe("reel");
    expect(normalizeContentFormat("carousel")).toBe("carousel");
    expect(normalizeContentFormat("image")).toBe("image");
    expect(normalizeContentFormat("text")).toBe("text");
  });

  it("maps the natural phrasings ContentPlannerAgent actually produces", () => {
    // These are verbatim formats observed from real planner output.
    expect(normalizeContentFormat("short-form video")).toBe("reel");
    expect(normalizeContentFormat("text post")).toBe("text");
    expect(normalizeContentFormat("Carousel")).toBe("carousel");
    expect(normalizeContentFormat("carousel post")).toBe("carousel");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeContentFormat("  REEL  ")).toBe("reel");
    expect(normalizeContentFormat("Static Image")).toBe("image");
  });

  it("falls back to image for unknown or missing formats", () => {
    expect(normalizeContentFormat("something else entirely")).toBe("image");
    expect(normalizeContentFormat(null)).toBe("image");
    expect(normalizeContentFormat(undefined)).toBe("image");
  });
});
