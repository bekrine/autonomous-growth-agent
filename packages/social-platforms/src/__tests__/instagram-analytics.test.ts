import { describe, expect, it, vi } from "vitest";
import { InstagramAnalyticsProvider, candidateMetricsFor, sanitizeRaw, describeMetricFailure } from "../adapters/instagram/instagram-analytics.js";
import { PublishingError } from "../publishing-types.js";
import type { MetaGraphClient } from "../adapters/instagram/graph-client.js";

/**
 * The Graph client is stubbed throughout — these tests never reach Meta.
 */
function stubClient(handler: (path: string, params: Record<string, string>) => unknown): MetaGraphClient {
  return { get: vi.fn(async (path: string, params: Record<string, string>) => handler(path, params)) } as unknown as MetaGraphClient;
}

function insight(value: number) {
  return { data: [{ values: [{ value }] }] };
}

const MEDIA_FIELDS = {
  id: "1789",
  media_type: "IMAGE",
  media_product_type: "FEED",
  permalink: "https://instagram.com/p/abc/",
  timestamp: "2026-09-01T10:00:00+0000",
};

describe("candidate metrics per media type", () => {
  it("asks for feed metrics on a feed post and reel metrics on a reel", () => {
    expect(candidateMetricsFor("FEED", "IMAGE")).toContain("saved");
    expect(candidateMetricsFor("FEED", "IMAGE")).toContain("follows");
    // profile_visits/follows are not valid for reels; asking would just error.
    expect(candidateMetricsFor("REELS", "VIDEO")).not.toContain("profile_visits");
    expect(candidateMetricsFor("STORY", "IMAGE")).toContain("replies");
  });
});

describe("InstagramAnalyticsProvider.getMediaInsights", () => {
  it("returns normalized platform metrics for a successful fetch", async () => {
    const client = stubClient((path, params) => {
      if (!path.includes("/insights")) return MEDIA_FIELDS;
      const values: Record<string, number> = {
        reach: 1000,
        likes: 80,
        comments: 10,
        shares: 6,
        saved: 4,
        views: 2000,
        total_interactions: 100,
        follows: 5,
        profile_visits: 12,
      };
      return insight(values[params.metric!] ?? 0);
    });

    const result = await new InstagramAnalyticsProvider(client).getMediaInsights({
      externalPostId: "1789",
      accessToken: "token",
    });

    expect(result.outcome).toBe("complete");
    expect(result.mediaType).toBe("IMAGE");
    expect(result.permalink).toBe("https://instagram.com/p/abc/");
    expect(result.metrics.find((m) => m.name === "reach")).toMatchObject({ value: 1000, available: true });
    expect(result.metrics.every((m) => m.available)).toBe(true);
  });

  it("marks an unsupported metric unavailable and keeps the rest — never zero", async () => {
    const client = stubClient((path, params) => {
      if (!path.includes("/insights")) return MEDIA_FIELDS;
      if (params.metric === "shares") {
        throw new PublishingError("PLATFORM_ERROR", "metric not supported", "(#100) unsupported metric");
      }
      return insight(42);
    });

    const result = await new InstagramAnalyticsProvider(client).getMediaInsights({
      externalPostId: "1789",
      accessToken: "token",
    });

    const shares = result.metrics.find((m) => m.name === "shares")!;
    expect(shares.available).toBe(false);
    expect(shares.value).toBeUndefined();
    expect(shares.reason).toBeTruthy();

    // One bad metric must not poison the others.
    expect(result.metrics.find((m) => m.name === "reach")).toMatchObject({ value: 42, available: true });
    expect(result.outcome).toBe("partial");
  });

  it("reports a permission failure explicitly rather than as missing data", async () => {
    const client = stubClient((path) => {
      if (!path.includes("/insights")) return MEDIA_FIELDS;
      throw new PublishingError("PERMISSION_DENIED", "denied", "(#10) Application does not have permission");
    });

    const result = await new InstagramAnalyticsProvider(client).getMediaInsights({
      externalPostId: "1789",
      accessToken: "token",
    });

    expect(result.outcome).toBe("failed");
    expect(result.metrics.every((m) => !m.available)).toBe(true);
    // The operator needs to know this is fixable by reconnecting, not "no data".
    expect(result.metrics[0]!.reason).toContain("instagram_manage_insights");
  });

  it("surfaces rate limiting distinctly so it can be retried", async () => {
    const client = stubClient((path) => {
      if (!path.includes("/insights")) return MEDIA_FIELDS;
      throw new PublishingError("RATE_LIMITED", "slow down", "(#4) rate limit");
    });

    const result = await new InstagramAnalyticsProvider(client).getMediaInsights({
      externalPostId: "1789",
      accessToken: "token",
    });

    expect(result.metrics[0]!.reason).toContain("Rate limited");
  });

  it("treats a malformed provider response as unavailable rather than guessing", async () => {
    const client = stubClient((path) => {
      if (!path.includes("/insights")) return MEDIA_FIELDS;
      return { data: [{ values: [{ value: "not-a-number" }] }] };
    });

    const result = await new InstagramAnalyticsProvider(client).getMediaInsights({
      externalPostId: "1789",
      accessToken: "token",
    });

    expect(result.outcome).toBe("failed");
    expect(result.metrics.every((m) => m.available === false)).toBe(true);
  });

  it("reads the total_value response shape as well as values[]", async () => {
    const client = stubClient((path) => {
      if (!path.includes("/insights")) return MEDIA_FIELDS;
      return { data: [{ total_value: { value: 777 } }] };
    });

    const result = await new InstagramAnalyticsProvider(client).getMediaInsights({
      externalPostId: "1789",
      accessToken: "token",
    });

    expect(result.metrics.find((m) => m.name === "reach")).toMatchObject({ value: 777, available: true });
  });
});

describe("InstagramAnalyticsProvider.getAccountInsights", () => {
  it("collects profile counts even when insight metrics are denied", async () => {
    const client = stubClient((path) => {
      if (path.includes("/insights")) {
        throw new PublishingError("PERMISSION_DENIED", "denied", "(#10)");
      }
      return { username: "test_account", followers_count: 154, follows_count: 20, media_count: 12 };
    });

    const result = await new InstagramAnalyticsProvider(client).getAccountInsights({
      platformAccountId: "17841400000000000",
      accessToken: "token",
    });

    expect(result.username).toBe("test_account");
    expect(result.metrics.find((m) => m.name === "followers_count")).toMatchObject({ value: 154, available: true });
    // Profile data succeeded, insights did not — that is precisely "partial".
    expect(result.outcome).toBe("partial");
  });

  it("is complete when both profile fields and insights resolve", async () => {
    const client = stubClient((path) => {
      if (path.includes("/insights")) return { data: [{ total_value: { value: 10 } }] };
      return { username: "a", followers_count: 1, follows_count: 2, media_count: 3 };
    });

    const result = await new InstagramAnalyticsProvider(client).getAccountInsights({
      platformAccountId: "178414",
      accessToken: "token",
    });

    expect(result.outcome).toBe("complete");
  });
});

describe("raw payload sanitization", () => {
  it("redacts anything credential-shaped before persistence", () => {
    const sanitized = sanitizeRaw({
      access_token: "EAAsecret",
      nested: { client_secret: "shh", app_secret: "shh", code: "oauth-code", reach: 10 },
      list: [{ token: "abc" }],
    });

    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("EAAsecret");
    expect(serialized).not.toContain("oauth-code");
    expect(serialized).not.toContain("shh");
    // Non-credential data survives, because the payload's purpose is debugging.
    expect(serialized).toContain('"reach":10');
  });
});

describe("describeMetricFailure", () => {
  it("explains permission failures actionably and stays vague about internals", () => {
    const message = describeMetricFailure(new PublishingError("PERMISSION_DENIED", "x", "(#10) fbtrace_id=abc"));
    expect(message).toContain("instagram_manage_insights");
    expect(message).not.toContain("fbtrace_id");
  });

  it("falls back to a neutral reason for unknown errors", () => {
    expect(describeMetricFailure(new Error("boom"))).toBe("Metric could not be retrieved.");
  });
});
