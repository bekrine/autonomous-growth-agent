import { describe, expect, it } from "vitest";
import { MockMediaGenerator } from "../generator.js";

describe("MockMediaGenerator", () => {
  it("returns a placeholder image", async () => {
    const generator = new MockMediaGenerator();
    const result = await generator.generateImage({ prompt: "a cat" });
    expect(result.url).toContain("https://");
    expect(result.mimeType).toBe("image/png");
  });
});
