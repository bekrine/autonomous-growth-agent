import { describe, expect, it } from "vitest";
import { SocialPlatformRegistry } from "../registry.js";

describe("SocialPlatformRegistry", () => {
  it("resolves the instagram adapter", () => {
    const registry = new SocialPlatformRegistry();
    expect(registry.get("instagram").platform).toBe("instagram");
  });

  it("throws for unknown platforms", () => {
    const registry = new SocialPlatformRegistry();
    // @ts-expect-error intentional invalid platform for test
    expect(() => registry.get("tiktok")).toThrow();
  });
});
