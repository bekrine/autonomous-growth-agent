import { describe, expect, it } from "vitest";
import { SocialPlatformRegistry } from "../registry.js";
import { InstagramAdapter } from "../adapters/instagram/instagram-adapter.js";
import { MockInstagramAdapter } from "../adapters/instagram/mock-instagram-adapter.js";

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

  it("defaults to the mock Instagram adapter so nothing can reach Meta by accident", () => {
    const registry = new SocialPlatformRegistry();
    expect(registry.get("instagram")).toBeInstanceOf(MockInstagramAdapter);
  });

  it("uses the real adapter only when publishing is explicitly enabled", () => {
    const registry = new SocialPlatformRegistry({ instagramPublishingEnabled: true });
    expect(registry.get("instagram")).toBeInstanceOf(InstagramAdapter);
  });

  it("exposes a publisher for instagram but not facebook (not implemented this phase)", () => {
    const registry = new SocialPlatformRegistry();
    expect(registry.getPublisher("instagram").platform).toBe("instagram");
    expect(() => registry.getPublisher("facebook")).toThrow();
  });
});
