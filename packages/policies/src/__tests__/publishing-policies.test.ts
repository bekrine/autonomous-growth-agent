import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../policy-engine.js";
import { KillSwitchStore } from "../kill-switch.js";
import { KillSwitchPolicy } from "../policies/kill-switch-policy.js";
import {
  AutoPublishPolicy,
  MediaReadyPolicy,
  PUBLISH_ACTION,
  PublishableContentPolicy,
  PublishingJobStatePolicy,
  PublishingRateLimitPolicy,
  SocialConnectionPolicy,
} from "../policies/publishing-policies.js";

const ACCOUNT = "acc-1";

function ctx(payload: Record<string, unknown>) {
  return { accountId: ACCOUNT, actionType: PUBLISH_ACTION, payload };
}

/** A payload that passes every publishing policy; tests override one field at a time. */
const validPayload = {
  contentStatus: "ready_for_publishing",
  reviewApproved: true,
  connectionStatus: "connected",
  accountType: "business",
  mediaValid: true,
  publishedLastDay: 0,
  publishedLastHour: 0,
  initiatedBy: "human",
  jobStatus: "queued",
};

describe("PublishableContentPolicy", () => {
  it("allows content that is ready for publishing", () => {
    expect(new PublishableContentPolicy().evaluate(ctx(validPayload)).allowed).toBe(true);
  });

  it.each(["generated", "reviewing", "review_failed", "draft"])("rejects status %s", (contentStatus) => {
    const result = new PublishableContentPolicy().evaluate(ctx({ ...validPayload, contentStatus }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/has not passed review/);
  });

  it("ignores non-publishing actions", () => {
    const policy = new PublishableContentPolicy();
    expect(policy.evaluate({ accountId: ACCOUNT, actionType: "generateImage", payload: {} }).allowed).toBe(true);
  });
});

describe("SocialConnectionPolicy", () => {
  it("rejects when there is no connection", () => {
    const result = new SocialConnectionPolicy().evaluate(ctx({ ...validPayload, connectionStatus: undefined }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/No social connection/);
  });

  it.each(["expired", "revoked", "error"])("rejects a %s connection", (connectionStatus) => {
    expect(new SocialConnectionPolicy().evaluate(ctx({ ...validPayload, connectionStatus })).allowed).toBe(false);
  });

  it("rejects an expired token even when status says connected", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const result = new SocialConnectionPolicy().evaluate(ctx({ ...validPayload, connectionExpiresAt: past }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });

  it("rejects personal (non-professional) Instagram accounts", () => {
    const result = new SocialConnectionPolicy().evaluate(ctx({ ...validPayload, accountType: "personal" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Professional/);
  });
});

describe("PublishingRateLimitPolicy", () => {
  const options = { maxPerDay: 5, maxPerHour: 2, minMinutesBetweenPosts: 10 };

  it("allows when under all limits", () => {
    expect(new PublishingRateLimitPolicy(options).evaluate(ctx(validPayload)).allowed).toBe(true);
  });

  it("rejects at the daily cap", () => {
    const result = new PublishingRateLimitPolicy(options).evaluate(ctx({ ...validPayload, publishedLastDay: 5 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Daily publishing limit/);
  });

  it("rejects at the hourly cap", () => {
    const result = new PublishingRateLimitPolicy(options).evaluate(ctx({ ...validPayload, publishedLastHour: 2 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Hourly publishing limit/);
  });

  it("enforces minimum spacing between posts", () => {
    const justNow = new Date(Date.now() - 60_000).toISOString();
    const result = new PublishingRateLimitPolicy(options).evaluate(
      ctx({ ...validPayload, lastPublishedAt: justNow }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Minimum spacing/);
  });

  it("allows once the spacing window has passed", () => {
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(
      new PublishingRateLimitPolicy(options).evaluate(ctx({ ...validPayload, lastPublishedAt: longAgo })).allowed,
    ).toBe(true);
  });
});

describe("AutoPublishPolicy", () => {
  it("blocks agent-initiated publishing when disabled", () => {
    const result = new AutoPublishPolicy(false).evaluate(ctx({ ...validPayload, initiatedBy: "agent" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/AUTO_PUBLISH_ENABLED/);
  });

  it("allows human-initiated publishing even when disabled", () => {
    expect(new AutoPublishPolicy(false).evaluate(ctx({ ...validPayload, initiatedBy: "human" })).allowed).toBe(true);
  });

  it("allows agent-initiated publishing once enabled", () => {
    expect(new AutoPublishPolicy(true).evaluate(ctx({ ...validPayload, initiatedBy: "agent" })).allowed).toBe(true);
  });
});

describe("PublishingJobStatePolicy", () => {
  it("blocks a cancelled job", () => {
    const result = new PublishingJobStatePolicy().evaluate(ctx({ ...validPayload, jobStatus: "cancelled" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/cancelled/);
  });

  it("blocks re-publishing an already-published job", () => {
    expect(
      new PublishingJobStatePolicy().evaluate(ctx({ ...validPayload, jobStatus: "published" })).allowed,
    ).toBe(false);
  });

  it("blocks a job whose scheduled time has not arrived", () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = new PublishingJobStatePolicy().evaluate(ctx({ ...validPayload, scheduledFor: future }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/scheduled for a later time/);
  });

  it("allows a job whose scheduled time has arrived", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(new PublishingJobStatePolicy().evaluate(ctx({ ...validPayload, scheduledFor: past })).allowed).toBe(true);
  });
});

describe("publishing policy engine", () => {
  function engine(killSwitch: KillSwitchStore, autoPublish = false) {
    return new PolicyEngine([
      new KillSwitchPolicy(killSwitch),
      new PublishingJobStatePolicy(),
      new PublishableContentPolicy(),
      new SocialConnectionPolicy(),
      new MediaReadyPolicy(),
      new AutoPublishPolicy(autoPublish),
      new PublishingRateLimitPolicy({ maxPerDay: 5, maxPerHour: 2, minMinutesBetweenPosts: 0 }),
    ]);
  }

  it("allows a fully valid publish", async () => {
    const result = await engine(new KillSwitchStore(false)).evaluate(ctx(validPayload));
    expect(result.allowed).toBe(true);
  });

  it("the kill switch overrides everything else", async () => {
    const killSwitch = new KillSwitchStore(true);
    const result = await engine(killSwitch).evaluate(ctx(validPayload));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/kill-switch/);
  });

  it("a per-account kill switch blocks only that account", async () => {
    const killSwitch = new KillSwitchStore(false);
    killSwitch.setAccountDisabled(ACCOUNT, true);
    expect((await engine(killSwitch).evaluate(ctx(validPayload))).allowed).toBe(false);

    const other = { accountId: "acc-2", actionType: PUBLISH_ACTION, payload: validPayload };
    expect((await engine(killSwitch).evaluate(other)).allowed).toBe(true);
  });

  it("rejects invalid media with the specific issue surfaced", async () => {
    const result = await engine(new KillSwitchStore(false)).evaluate(
      ctx({ ...validPayload, mediaValid: false, mediaIssue: "Instagram accepts JPEG images only (got image/svg+xml)." }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/JPEG/);
  });
});
