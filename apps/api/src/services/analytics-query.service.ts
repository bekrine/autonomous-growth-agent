import type { AnalyticsRepository } from "@agent/database";
import type { AnalyticsService as CoreAnalyticsService } from "@agent/agent-core";

/**
 * HTTP-facing read model for analytics.
 *
 * All measurement logic lives in agent-core's AnalyticsService; this class
 * only shapes what the dashboard needs and enforces the API's own rule:
 * raw provider payloads never leave the server. `metrics` on a snapshot row
 * holds sanitized provider JSON that is useful for debugging but is not part
 * of the public contract, so it is dropped here rather than serialized.
 */
export class AnalyticsQueryService {
  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly core: CoreAnalyticsService,
  ) {}

  /** Backwards-compatible Phase 1 endpoint. */
  async getForAccount(accountId: string) {
    const snapshots = await this.repo.listForAccount(accountId);
    return snapshots.map(toPublicSnapshot);
  }

  async getOverview(accountId: string) {
    const [performance, growth, baseline, insights, states, publishedPosts] = await Promise.all([
      this.core.getPostPerformance(accountId, 50),
      this.core.getGrowthSeries(accountId),
      this.core.getAccountBaseline(accountId),
      this.repo.listInsights(accountId, 10),
      this.repo.listStatesForAccount(accountId),
      this.repo.listPublishedPostsWithDimensions(accountId, 500),
    ]);

    const reachValues = performance
      .map((entry) => valueOf(entry.metrics, "reach"))
      .filter((v): v is number => v !== undefined);
    const engagementValues = performance
      .map((entry) => valueOf(entry.metrics, "engagement_rate"))
      .filter((v): v is number => v !== undefined);

    return {
      followers: {
        // undefined, not 0 — "we have no follower snapshot" is not "zero followers".
        current: growth.current,
        change: growth.change,
        observations: growth.observations,
      },
      content: {
        // Counted from published posts, not analytics state rows: a post
        // published before analytics existed has no state row, and reporting
        // "0 published / 3 measured" would be self-contradictory.
        published: publishedPosts.length,
        withAnalytics: performance.length,
        averageReach: average(reachValues),
        averageEngagementRate: average(engagementValues),
      },
      baseline: { sampleSize: baseline.sampleSize, metrics: baseline.metrics },
      collectionStatus: summarizeStatuses(states),
      topPosts: await this.getTopPosts(accountId, { limit: 5 }),
      insights: insights.map(toPublicInsight),
    };
  }

  /** Post performance with dimensions, sortable by any measured or derived metric. */
  async getTopPosts(accountId: string, options: { sortBy?: string; limit?: number } = {}) {
    const sortBy = options.sortBy ?? "performance_score";
    const limit = options.limit ?? 20;

    const [performance, baseline, posts] = await Promise.all([
      this.core.getPostPerformance(accountId, 100),
      this.core.getAccountBaseline(accountId),
      this.repo.listPublishedPostsWithDimensions(accountId, 200),
    ]);

    const postsById = new Map(posts.map((post) => [post.id, post]));

    const rows = performance.map((entry) => {
      const metrics = Object.fromEntries(entry.metrics.map((m) => [m.name, m.available ? m.value : undefined]));
      const score = this.core.scorePost(metrics, baseline);
      const post = entry.snapshot.contentPostId ? postsById.get(entry.snapshot.contentPostId) : undefined;
      const publishedAt = post?.publishedAt ?? null;

      return {
        contentPostId: entry.snapshot.contentPostId,
        contentGenerationId: entry.snapshot.contentGenerationId,
        externalPostId: entry.snapshot.externalPostId,
        capturedAt: entry.snapshot.capturedAt,
        outcome: entry.snapshot.outcome,
        publishedAt,
        // UTC everywhere; the dashboard converts at render time.
        postingHourUtc: publishedAt ? publishedAt.getUTCHours() : null,
        postingDayUtc: publishedAt ? UTC_DAYS[publishedAt.getUTCDay()] : null,
        generationVersion: post?.currentGenerationVersion ?? null,
        experimentId: post?.experimentId ?? null,
        metrics: entry.metrics.map(toPublicMetric),
        performanceScore: score.available ? score.score : undefined,
        performanceScoreCoverage: score.coverage,
        performanceScoreFormula: score.formula,
      };
    });

    const sorted = [...rows].sort((a, b) => sortValue(b, sortBy) - sortValue(a, sortBy));
    return sorted.slice(0, limit);
  }

  async getPostAnalytics(contentPostId: string) {
    const { state, snapshots, latest, metrics } = await this.core.getPostAnalytics(contentPostId);

    return {
      contentPostId,
      status: state?.status ?? "pending",
      externalPostId: state?.externalPostId ?? null,
      platform: state?.platform ?? null,
      publishedAt: state?.publishedAt ?? null,
      lastSnapshotAt: state?.lastSnapshotAt ?? null,
      nextSnapshotAt: state?.nextSnapshotAt ?? null,
      lastError: state?.lastError ?? null,
      latestSnapshot: latest ? toPublicSnapshot(latest) : null,
      metrics: metrics.map((m) => ({
        name: m.metricName,
        platformName: m.platformMetricName,
        value: m.metricValue === null ? undefined : Number(m.metricValue),
        unit: m.metricUnit,
        available: m.available,
        unavailableReason: m.unavailableReason,
        source: m.source,
        computation: m.computation,
      })),
      // Full history so the dashboard can chart how a post matured.
      history: snapshots.map(toPublicSnapshot),
    };
  }

  async getGrowth(accountId: string) {
    const growth = await this.core.getGrowthSeries(accountId);
    const series = growth.series;

    // Day-over-day deltas between *observed* snapshots only. Nothing is
    // interpolated: a gap in snapshots stays a gap.
    const daily: { day: string | null; followers?: number; gained?: number }[] = [];
    let previous: number | undefined;
    for (const point of series) {
      const gained = previous !== undefined && point.followers !== undefined ? point.followers - previous : undefined;
      daily.push({ day: point.day, followers: point.followers, gained });
      if (point.followers !== undefined) previous = point.followers;
    }

    return { ...growth, daily };
  }

  async getInsights(accountId: string, limit = 50) {
    const rows = await this.repo.listInsights(accountId, limit);
    return rows.map(toPublicInsight);
  }
}

const UTC_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function sortValue(row: { metrics: { name: string; value?: number }[]; performanceScore?: number }, sortBy: string) {
  if (sortBy === "performance_score") return row.performanceScore ?? -1;
  const metric = row.metrics.find((m) => m.name === sortBy);
  return metric?.value ?? -1;
}

function valueOf(metrics: { name: string; available: boolean; value?: number }[], name: string) {
  const metric = metrics.find((m) => m.name === name);
  return metric?.available ? metric.value : undefined;
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function summarizeStatuses(states: { status: string }[]) {
  const counts: Record<string, number> = {};
  for (const state of states) counts[state.status] = (counts[state.status] ?? 0) + 1;
  return counts;
}

function toPublicMetric(metric: {
  name: string;
  platformName: string;
  value?: number;
  unit: string;
  available: boolean;
  unavailableReason?: string;
  source: string;
  computation?: unknown;
}) {
  return {
    name: metric.name,
    platformName: metric.platformName,
    value: metric.value,
    unit: metric.unit,
    available: metric.available,
    unavailableReason: metric.unavailableReason,
    source: metric.source,
    computation: metric.computation,
  };
}

/** Drops the raw provider payload — useful server-side, not part of the public contract. */
function toPublicSnapshot(snapshot: {
  id: string;
  contentPostId: string | null;
  metricType: string;
  capturedAt: Date;
  collectionWindow: string | null;
  outcome: string | null;
  externalPostId: string | null;
  errorReason: string | null;
}) {
  return {
    id: snapshot.id,
    contentPostId: snapshot.contentPostId,
    metricType: snapshot.metricType,
    capturedAt: snapshot.capturedAt,
    collectionWindow: snapshot.collectionWindow,
    outcome: snapshot.outcome,
    externalPostId: snapshot.externalPostId,
    errorReason: snapshot.errorReason,
  };
}

function toPublicInsight(insight: {
  id: string;
  insightType: string;
  dimension: string | null;
  dimensionValue: string | null;
  finding: string;
  evidence: unknown;
  confidence: string | null;
  sampleSize: string | null;
  createdAt: Date;
}) {
  return {
    id: insight.id,
    type: insight.insightType,
    dimension: insight.dimension,
    dimensionValue: insight.dimensionValue,
    finding: insight.finding,
    evidence: insight.evidence,
    confidence: insight.confidence === null ? undefined : Number(insight.confidence),
    sampleSize: insight.sampleSize === null ? undefined : Number(insight.sampleSize),
    createdAt: insight.createdAt,
  };
}
