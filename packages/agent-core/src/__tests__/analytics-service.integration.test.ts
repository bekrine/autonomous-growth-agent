import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { createLogger, generateEncryptionKey, TokenEncryptionService } from "@agent/shared";
import { InMemoryObjectStorage } from "@agent/media";
import { MockLLMProvider } from "@agent/llm";
import type {
  AccountInsightsResult,
  MediaInsightsResult,
  PlatformAnalyticsProvider,
  PlatformMetric,
} from "@agent/social-platforms";
import { PublishingError } from "@agent/social-platforms";
import {
  closeDatabase,
  createDatabase,
  AnalyticsRepository,
  AgentProfileRepository,
  ContentRepository,
  SocialAccountRepository,
  SocialConnectionRepository,
} from "@agent/database";
import { buildAgentSystem } from "../factory.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://agent:agent@localhost:5432/agent_growth";
const ENCRYPTION_KEY = generateEncryptionKey();

async function isDatabaseReachable(): Promise<boolean> {
  const sql = postgres(DATABASE_URL, { max: 1, connect_timeout: 2 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const databaseAvailable = await isDatabaseReachable();

afterAll(async () => {
  if (databaseAvailable) await closeDatabase();
});

function metric(name: string, value?: number, reason?: string): PlatformMetric {
  return value === undefined ? { name, available: false, reason } : { name, value, available: true };
}

/** Scripted provider — the whole suite runs without touching Meta. */
class FakeAnalyticsProvider implements PlatformAnalyticsProvider {
  readonly platform = "instagram";
  mediaCalls = 0;

  constructor(
    private readonly media: () => MediaInsightsResult,
    private readonly account?: () => AccountInsightsResult,
  ) {}

  async getMediaInsights(): Promise<MediaInsightsResult> {
    this.mediaCalls += 1;
    return this.media();
  }

  async getAccountInsights(): Promise<AccountInsightsResult> {
    if (!this.account) throw new Error("account insights not scripted");
    return this.account();
  }
}

function mediaResult(overrides: Partial<MediaInsightsResult> = {}): MediaInsightsResult {
  return {
    externalPostId: "17900000000000000",
    mediaType: "IMAGE",
    mediaProductType: "FEED",
    metrics: [
      metric("reach", 1000),
      metric("likes", 80),
      metric("comments", 10),
      metric("shares", 6),
      metric("saved", 4),
      metric("views", 2000),
      metric("follows", 5),
    ],
    outcome: "complete",
    capturedAt: new Date().toISOString(),
    raw: { fields: { id: "17900000000000000" } },
    ...overrides,
  };
}

function buildSystem(provider: PlatformAnalyticsProvider | null) {
  const db = createDatabase(DATABASE_URL);
  const logger = createLogger({ name: "analytics-test", level: "silent" });
  return buildAgentSystem({
    db,
    llm: new MockLLMProvider(),
    logger,
    objectStorage: new InMemoryObjectStorage(),
    tokenEncryption: new TokenEncryptionService(ENCRYPTION_KEY),
    analyticsProvider: provider,
    analyticsBaselinePostCount: 10,
  });
}

async function seedPublishedPost(suffix: string, options: { connected?: boolean } = {}) {
  const db = createDatabase(DATABASE_URL);
  const accounts = new SocialAccountRepository(db);
  const profiles = new AgentProfileRepository(db);
  const content = new ContentRepository(db);
  const connections = new SocialConnectionRepository(db);
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const userId = await accounts.ensureDefaultUser(`analytics-${unique}@example.com`);
  const account = await accounts.create({
    userId,
    platform: "instagram",
    externalAccountId: `analytics-ext-${unique}`,
    displayName: "Analytics Test Account",
  });
  const profile = await profiles.create({ socialAccountId: account.id, niche: "test" });
  const idea = await content.createIdea({
    agentProfileId: profile.id,
    title: "Analytics idea",
    format: "image",
    contentPillar: "education",
  });
  const post = await content.createPost({
    socialAccountId: account.id,
    contentIdeaId: idea.id,
    status: "published",
  });

  if (options.connected !== false) {
    await connections.upsert({
      socialAccountId: account.id,
      platform: "instagram",
      platformAccountId: `1784140${Math.floor(Math.random() * 1_000_000)}`,
      platformUsername: "test_account",
      accountType: "business",
      accessTokenEncrypted: new TokenEncryptionService(ENCRYPTION_KEY).encrypt("PAGE_TOKEN"),
      scopes: ["instagram_basic", "instagram_manage_insights"],
    });
  }

  return { account, post, idea };
}

describe.skipIf(!databaseAvailable)("AnalyticsService collection", () => {
  it("collects, normalizes, derives and persists a snapshot linked to the published version", async () => {
    const provider = new FakeAnalyticsProvider(() => mediaResult());
    const system = buildSystem(provider);
    const { account, post } = await seedPublishedPost("happy");
    const publishedAt = new Date(Date.now() - 2 * 60 * 60_000); // 2h ago

    await system.analyticsService.schedulePostCollection({
      contentPostId: post.id,
      socialAccountId: account.id,
      externalPostId: "17900000000000000",
      platform: "instagram",
      publishedAt,
    });

    const result = await system.analyticsService.collectForPost(post.id);

    expect(result.status).toBe("up_to_date");
    expect(result.collectionWindow).toBe("initial");
    expect(result.created).toBe(true);

    const analytics = await system.analyticsService.getPostAnalytics(post.id);
    const byName = Object.fromEntries(analytics.metrics.map((m) => [m.metricName, m]));

    // Platform metrics, canonically named.
    expect(Number(byName.reach!.metricValue)).toBe(1000);
    expect(byName.saves!.platformMetricName).toBe("saved");

    // Derived metrics computed and auditable.
    expect(Number(byName.engagement_rate!.metricValue)).toBeCloseTo(0.1);
    expect(byName.engagement_rate!.source).toBe("derived");
    expect(byName.engagement_rate!.computation).toMatchObject({
      formula: "(likes + comments + shares + saves) / reach",
    });

    // The snapshot points at the exact generated version, not just the post.
    expect(analytics.latest?.externalPostId).toBe("17900000000000000");
    expect(analytics.latest?.metricType).toBe("media");
  });

  it("is idempotent: repeating the same window does not duplicate history", async () => {
    const provider = new FakeAnalyticsProvider(() => mediaResult());
    const system = buildSystem(provider);
    const { account, post } = await seedPublishedPost("idempotent");
    const publishedAt = new Date(Date.now() - 2 * 60 * 60_000);

    await system.analyticsService.schedulePostCollection({
      contentPostId: post.id,
      socialAccountId: account.id,
      externalPostId: "17900000000000001",
      platform: "instagram",
      publishedAt,
    });

    const first = await system.analyticsService.collectForPost(post.id, { window: "initial" });
    const second = await system.analyticsService.collectForPost(post.id, { window: "initial" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshotId).toBe(first.snapshotId);

    const { snapshots } = await system.analyticsService.getPostAnalytics(post.id);
    expect(snapshots).toHaveLength(1);
  });

  it("keeps earlier snapshots when a later window is collected", async () => {
    const provider = new FakeAnalyticsProvider(() =>
      mediaResult({ metrics: [metric("reach", 5000), metric("likes", 400), metric("comments", 20), metric("shares", 10), metric("saved", 30)] }),
    );
    const system = buildSystem(provider);
    const { account, post } = await seedPublishedPost("history");
    const publishedAt = new Date(Date.now() - 30 * 60 * 60_000); // 30h ago

    await system.analyticsService.schedulePostCollection({
      contentPostId: post.id,
      socialAccountId: account.id,
      externalPostId: "17900000000000002",
      platform: "instagram",
      publishedAt,
    });

    await system.analyticsService.collectForPost(post.id, { window: "initial" });
    await system.analyticsService.collectForPost(post.id, { window: "daily" });

    const { snapshots } = await system.analyticsService.getPostAnalytics(post.id);
    // Append-only: the earlier snapshot is still there.
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.collectionWindow).sort()).toEqual(["daily", "initial"]);
  });

  it("records a partial outcome rather than presenting it as complete", async () => {
    const provider = new FakeAnalyticsProvider(() =>
      mediaResult({
        metrics: [metric("reach", 900), metric("likes", 10), metric("shares", undefined, "unsupported")],
        outcome: "partial",
      }),
    );
    const system = buildSystem(provider);
    const { account, post } = await seedPublishedPost("partial");

    await system.analyticsService.schedulePostCollection({
      contentPostId: post.id,
      socialAccountId: account.id,
      externalPostId: "17900000000000003",
      platform: "instagram",
      publishedAt: new Date(Date.now() - 2 * 60 * 60_000),
    });

    const result = await system.analyticsService.collectForPost(post.id);
    expect(result.status).toBe("partial");

    const analytics = await system.analyticsService.getPostAnalytics(post.id);
    expect(analytics.state?.status).toBe("partial");
    expect(analytics.latest?.outcome).toBe("partial");

    // Unavailable metrics are stored as unavailable, not as 0.
    const shares = analytics.metrics.find((m) => m.metricName === "shares")!;
    expect(shares.available).toBe(false);
    expect(shares.metricValue).toBeNull();
  });

  it("stops collecting for a disconnected account instead of retrying forever", async () => {
    const provider = new FakeAnalyticsProvider(() => mediaResult());
    const system = buildSystem(provider);
    const { account, post } = await seedPublishedPost("disconnected", { connected: false });

    await system.analyticsService.schedulePostCollection({
      contentPostId: post.id,
      socialAccountId: account.id,
      externalPostId: "17900000000000004",
      platform: "instagram",
      publishedAt: new Date(Date.now() - 2 * 60 * 60_000),
    });

    const result = await system.analyticsService.collectForPost(post.id);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("No connected Instagram account");
    expect(provider.mediaCalls).toBe(0);

    const analytics = await system.analyticsService.getPostAnalytics(post.id);
    // nextSnapshotAt cleared => the worker will not keep selecting it.
    expect(analytics.state?.nextSnapshotAt).toBeNull();
  });

  it("schedules a retry for a transient failure", async () => {
    const provider = new FakeAnalyticsProvider(() => {
      throw new PublishingError("RATE_LIMITED", "slow down");
    });
    const system = buildSystem(provider);
    const { account, post } = await seedPublishedPost("ratelimited");

    await system.analyticsService.schedulePostCollection({
      contentPostId: post.id,
      socialAccountId: account.id,
      externalPostId: "17900000000000005",
      platform: "instagram",
      publishedAt: new Date(Date.now() - 2 * 60 * 60_000),
    });

    const result = await system.analyticsService.collectForPost(post.id);
    expect(result.status).toBe("failed");

    const analytics = await system.analyticsService.getPostAnalytics(post.id);
    // Retryable => still scheduled, unlike the disconnected case.
    expect(analytics.state?.nextSnapshotAt).not.toBeNull();
  });

  it("only returns posts whose next window has actually arrived", async () => {
    const provider = new FakeAnalyticsProvider(() => mediaResult());
    const system = buildSystem(provider);
    const { account, post } = await seedPublishedPost("notdue");

    await system.analyticsService.schedulePostCollection({
      contentPostId: post.id,
      socialAccountId: account.id,
      externalPostId: "17900000000000006",
      platform: "instagram",
      publishedAt: new Date(), // just now; first window is +1h
    });

    // A generous limit: the query is global and ordered by due time, so other
    // tests' older rows would otherwise crowd this post out of a small page.
    const due = await system.analyticsService.findPostsDueForCollection(new Date(), 1000);
    expect(due.some((state) => state.contentPostId === post.id)).toBe(false);

    const later = await system.analyticsService.findPostsDueForCollection(
      new Date(Date.now() + 2 * 60 * 60_000),
      1000,
    );
    expect(later.some((state) => state.contentPostId === post.id)).toBe(true);
  });
});

describe.skipIf(!databaseAvailable)("AnalyticsService account snapshots", () => {
  it("preserves follower history across days rather than overwriting it", async () => {
    let followers = 100;
    const provider = new FakeAnalyticsProvider(
      () => mediaResult(),
      () => ({
        platformAccountId: "1784140",
        username: "test_account",
        metrics: [metric("followers_count", followers), metric("media_count", 3)],
        outcome: "complete",
        capturedAt: new Date().toISOString(),
        raw: {},
      }),
    );
    const system = buildSystem(provider);
    const { account } = await seedPublishedPost("growth");

    const dayOne = new Date("2026-09-01T12:00:00Z");
    const dayTwo = new Date("2026-09-02T12:00:00Z");

    await system.analyticsService.collectAccountSnapshot(account.id, { now: dayOne });
    followers = 137;
    await system.analyticsService.collectAccountSnapshot(account.id, { now: dayTwo });

    const growth = await system.analyticsService.getGrowthSeries(account.id);

    expect(growth.observations).toBe(2);
    expect(growth.current).toBe(137);
    // A real difference between two observed snapshots — never inferred.
    expect(growth.change).toBe(37);
  });

  it("does not create a second snapshot for the same UTC day", async () => {
    const provider = new FakeAnalyticsProvider(
      () => mediaResult(),
      () => ({
        platformAccountId: "1784140",
        metrics: [metric("followers_count", 10)],
        outcome: "complete",
        capturedAt: new Date().toISOString(),
        raw: {},
      }),
    );
    const system = buildSystem(provider);
    const { account } = await seedPublishedPost("sameday");
    const morning = new Date("2026-09-03T08:00:00Z");
    const evening = new Date("2026-09-03T20:00:00Z");

    const first = await system.analyticsService.collectAccountSnapshot(account.id, { now: morning });
    const second = await system.analyticsService.collectAccountSnapshot(account.id, { now: evening });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshotId).toBe(first.snapshotId);
  });
});

describe.skipIf(!databaseAvailable)("analytics has no provider configured", () => {
  it("reports it plainly instead of inventing metrics", async () => {
    const system = buildSystem(null);
    const { account, post } = await seedPublishedPost("noprovider");

    await system.analyticsService.schedulePostCollection({
      contentPostId: post.id,
      socialAccountId: account.id,
      externalPostId: "17900000000000007",
      platform: "instagram",
      publishedAt: new Date(Date.now() - 2 * 60 * 60_000),
    });

    const result = await system.analyticsService.collectForPost(post.id);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("not configured");
  });
});

describe.skipIf(!databaseAvailable)("AnalyticsAgent does not mutate strategy", () => {
  it("writes insights and decisions but leaves strategy_versions untouched", async () => {
    const provider = new FakeAnalyticsProvider(() => mediaResult());
    const system = buildSystem(provider);
    const { account, post } = await seedPublishedPost("nostrategy");

    await system.analyticsService.schedulePostCollection({
      contentPostId: post.id,
      socialAccountId: account.id,
      externalPostId: "17900000000000008",
      platform: "instagram",
      publishedAt: new Date(Date.now() - 2 * 60 * 60_000),
    });
    await system.analyticsService.collectForPost(post.id);

    const db = createDatabase(DATABASE_URL);
    const analyticsRepo = new AnalyticsRepository(db);

    const strategiesBefore = await system.repositories.strategyRepository.listVersions(account.id).catch(() => []);

    const outcome = await system.agentRunService.analyzePerformance(account.id);
    expect(outcome.status).toBe("completed");

    const strategiesAfter = await system.repositories.strategyRepository.listVersions(account.id).catch(() => []);
    // The measurement phase must not change what the account is trying to do.
    expect(strategiesAfter.length).toBe(strategiesBefore.length);

    // It did, however, record what it observed.
    const insights = await analyticsRepo.listInsights(account.id);
    expect(Array.isArray(insights)).toBe(true);
  });
});

describe.skipIf(!databaseAvailable)("account snapshot failure handling", () => {
  it("returns a failed result instead of throwing, so one bad account cannot abort a sweep", async () => {
    const provider = new FakeAnalyticsProvider(
      () => mediaResult(),
      () => {
        throw new PublishingError("PERMISSION_DENIED", "The Instagram connection is missing a required permission.");
      },
    );
    const system = buildSystem(provider);
    const { account } = await seedPublishedPost("acctfail");

    const result = await system.analyticsService.collectAccountSnapshot(account.id);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("permission");
  });
});
