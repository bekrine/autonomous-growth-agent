import type { AnalyticsRepository, ContentGenerationRepository, ContentRepository, PublishingJobRepository, SocialConnectionRepository } from "@agent/database";
import type { Logger } from "@agent/shared";
import { AppError, NotFoundError } from "@agent/shared";
import type { PlatformAnalyticsProvider } from "@agent/social-platforms";
import { PublishingError } from "@agent/social-platforms";
import type { TokenEncryptionService } from "@agent/shared";
import { normalizeMetrics, metricValue, type NormalizedMetric } from "./normalization.js";
import { calculateDerivedMetrics } from "./derived-metrics.js";
import {
  calculateAccountBaseline,
  calculatePerformanceScore,
  DEFAULT_PERFORMANCE_WEIGHTS,
  type AccountBaseline,
  type PerformanceWeights,
} from "./performance-scoring.js";
import {
  nextWindow,
  windowDueNow,
  DEFAULT_COLLECTION_WINDOWS,
  type CollectionWindow,
} from "./collection-windows.js";

/**
 * The single implementation of "collect and interpret analytics".
 *
 * Used identically by the API, the analytics worker, scheduled jobs and the
 * AnalyticsAgent — the same rule Phase 2 established for AgentRunService and
 * Phase 4 for PublishingService. The worker is plumbing; the logic lives here.
 *
 * It never reasons with an LLM: every number it produces is deterministic
 * arithmetic, so the same inputs always yield the same result and running it
 * costs nothing but a few API calls.
 */

export type AnalyticsStatus = "pending" | "collecting" | "up_to_date" | "partial" | "failed";

export interface AnalyticsServiceDeps {
  analyticsRepository: AnalyticsRepository;
  contentRepository: ContentRepository;
  contentGenerationRepository: ContentGenerationRepository;
  publishingJobRepository: PublishingJobRepository;
  socialConnectionRepository: SocialConnectionRepository;
  analyticsProvider: PlatformAnalyticsProvider | null;
  tokenEncryption: TokenEncryptionService | null;
  logger: Logger;
  collectionWindows?: CollectionWindow[];
  baselinePostCount?: number;
  performanceWeights?: PerformanceWeights;
  maxCollectionAttempts?: number;
}

export interface CollectionResult {
  contentPostId: string;
  status: AnalyticsStatus;
  collectionWindow?: string;
  snapshotId?: string;
  created?: boolean;
  metricsRecorded?: number;
  reason?: string;
}

/** Failures that can plausibly succeed later. Anything else must not be retried. */
const RETRYABLE_CODES = new Set(["RATE_LIMITED", "PLATFORM_ERROR", "UNKNOWN"]);

export class AnalyticsService {
  constructor(private readonly deps: AnalyticsServiceDeps) {}

  private get windows(): CollectionWindow[] {
    return this.deps.collectionWindows ?? DEFAULT_COLLECTION_WINDOWS;
  }

  /**
   * Registers a published post for analytics collection. Called from the
   * `content.published` reaction, never from the browser.
   */
  async schedulePostCollection(input: {
    contentPostId: string;
    socialAccountId: string;
    externalPostId: string;
    platform: string;
    publishedAt: Date;
  }) {
    const upcoming = nextWindow(input.publishedAt, [], this.windows);

    const state = await this.deps.analyticsRepository.upsertState({
      contentPostId: input.contentPostId,
      socialAccountId: input.socialAccountId,
      externalPostId: input.externalPostId,
      platform: input.platform,
      publishedAt: input.publishedAt,
      nextSnapshotAt: upcoming?.dueAt ?? null,
      status: "pending",
    });

    this.deps.logger.info(
      {
        contentPostId: input.contentPostId,
        externalPostId: input.externalPostId,
        nextSnapshotAt: upcoming?.dueAt?.toISOString(),
        window: upcoming?.window.name,
      },
      "analytics.collection_scheduled",
    );

    return state;
  }

  /** Posts whose next window has arrived. The worker asks for these — it does not scan. */
  async findPostsDueForCollection(now = new Date(), limit = 25) {
    return this.deps.analyticsRepository.listDueForCollection(now, limit);
  }

  /**
   * Collects one post's metrics: fetch → normalize → derive → persist.
   *
   * Idempotent at the database level via UNIQUE (account, post, type, window),
   * so a redelivered job returns the existing snapshot instead of duplicating
   * history.
   */
  async collectForPost(contentPostId: string, options: { window?: string; now?: Date } = {}): Promise<CollectionResult> {
    const now = options.now ?? new Date();
    const state = await this.deps.analyticsRepository.findStateByPost(contentPostId);
    if (!state) throw new NotFoundError("ContentAnalyticsState", contentPostId);

    if (!state.externalPostId) {
      return this.failCollection(contentPostId, "No external post id — the post has not been published", false);
    }

    const completed = (state.completedWindows as string[] | null) ?? [];
    const window =
      options.window ??
      (state.publishedAt ? windowDueNow(state.publishedAt, completed, now, this.windows)?.name : undefined);

    if (!window) {
      return { contentPostId, status: state.status as AnalyticsStatus, reason: "No collection window is due" };
    }

    if (!this.deps.analyticsProvider) {
      return this.failCollection(contentPostId, "Analytics provider is not configured", false);
    }

    const connection = await this.resolveConnection(state.socialAccountId);
    if ("reason" in connection) {
      // A disconnected account can never succeed by retrying — stop, don't loop.
      return this.failCollection(contentPostId, connection.reason, false);
    }

    await this.deps.analyticsRepository.updateState(contentPostId, { status: "collecting" });

    try {
      const insights = await this.deps.analyticsProvider.getMediaInsights({
        externalPostId: state.externalPostId,
        accessToken: connection.accessToken,
      });

      const normalized = normalizeMetrics(insights.metrics);
      const derived = calculateDerivedMetrics(normalized);
      const allMetrics = [...normalized, ...derived];

      // Ties the measurement to the exact generated version, which is what the
      // learning phase will need to answer "which content performed well?".
      const generation = await this.deps.contentGenerationRepository.findLatestByPostId(contentPostId);

      const { snapshot, created } = await this.deps.analyticsRepository.recordSnapshotIfAbsent({
        socialAccountId: state.socialAccountId,
        contentPostId,
        contentGenerationId: generation?.id ?? null,
        socialConnectionId: connection.connectionId,
        platform: state.platform ?? "instagram",
        externalPostId: state.externalPostId,
        metricType: "media",
        collectionWindow: window,
        metrics: insights.raw,
        capturedAt: new Date(insights.capturedAt),
        outcome: insights.outcome,
      });

      if (created) {
        await this.deps.analyticsRepository.saveMetrics(snapshot.id, allMetrics.map(toMetricInput));
      }

      const completedWindows = [...new Set([...completed, window])];
      const upcoming = state.publishedAt ? nextWindow(state.publishedAt, completedWindows, this.windows) : undefined;

      // `partial` is preserved rather than rounded up to success: a snapshot
      // missing metrics must not look complete.
      const status: AnalyticsStatus =
        insights.outcome === "failed" ? "failed" : insights.outcome === "partial" ? "partial" : "up_to_date";

      await this.deps.analyticsRepository.updateState(contentPostId, {
        status,
        lastSnapshotAt: new Date(insights.capturedAt),
        nextSnapshotAt: upcoming?.dueAt ?? null,
        completedWindows,
        attempts: 0,
        lastError: insights.outcome === "complete" ? null : "Some metrics were unavailable",
      });

      this.deps.logger.info(
        {
          contentPostId,
          externalPostId: state.externalPostId,
          window,
          outcome: insights.outcome,
          created,
          metricsAvailable: allMetrics.filter((m) => m.available).length,
          metricsTotal: allMetrics.length,
        },
        "analytics.snapshot_recorded",
      );

      return {
        contentPostId,
        status,
        collectionWindow: window,
        snapshotId: snapshot.id,
        created,
        metricsRecorded: created ? allMetrics.length : 0,
      };
    } catch (error) {
      const retryable = this.isRetryable(error);
      return this.failCollection(contentPostId, describeError(error), retryable, state.attempts);
    }
  }

  /**
   * Account-level snapshot. Windowed by UTC day so a run repeated within the
   * same day updates nothing — follower history stays one row per day and is
   * never overwritten by a later value.
   */
  async collectAccountSnapshot(socialAccountId: string, options: { now?: Date } = {}): Promise<CollectionResult> {
    const now = options.now ?? new Date();

    if (!this.deps.analyticsProvider) {
      return { contentPostId: socialAccountId, status: "failed", reason: "Analytics provider is not configured" };
    }

    const connection = await this.resolveConnection(socialAccountId);
    if ("reason" in connection) {
      return { contentPostId: socialAccountId, status: "failed", reason: connection.reason };
    }

    // A provider failure here must be a recorded outcome, not a thrown error:
    // the account sweep runs alongside post collection, and letting this
    // propagate would abort the whole sweep over one bad account.
    let insights;
    try {
      insights = await this.deps.analyticsProvider.getAccountInsights({
        platformAccountId: connection.platformAccountId,
        accessToken: connection.accessToken,
      });
    } catch (error) {
      const reason = describeError(error);
      this.deps.logger.warn({ socialAccountId, reason }, "analytics.account_snapshot_failed");
      return { contentPostId: socialAccountId, status: "failed", reason };
    }

    const normalized = normalizeMetrics(insights.metrics);
    const dayWindow = now.toISOString().slice(0, 10); // UTC day

    const { snapshot, created } = await this.deps.analyticsRepository.recordSnapshotIfAbsent({
      socialAccountId,
      contentPostId: null,
      socialConnectionId: connection.connectionId,
      platform: "instagram",
      metricType: "account",
      collectionWindow: dayWindow,
      metrics: insights.raw,
      capturedAt: new Date(insights.capturedAt),
      outcome: insights.outcome,
    });

    if (created) {
      await this.deps.analyticsRepository.saveMetrics(snapshot.id, normalized.map(toMetricInput));
    }

    this.deps.logger.info(
      { socialAccountId, day: dayWindow, created, outcome: insights.outcome },
      "analytics.account_snapshot_recorded",
    );

    return {
      contentPostId: socialAccountId,
      status: insights.outcome === "complete" ? "up_to_date" : insights.outcome === "partial" ? "partial" : "failed",
      collectionWindow: dayWindow,
      snapshotId: snapshot.id,
      created,
    };
  }

  // --- reads used by the API, dashboard and AnalyticsAgent ---

  /** Latest metrics per published post, with dimensions attached for grouping. */
  async getPostPerformance(socialAccountId: string, limit = 50) {
    const snapshots = await this.deps.analyticsRepository.listLatestPostSnapshots(socialAccountId, limit * 4);

    // Keep only the newest snapshot per post.
    const latestByPost = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      if (!snapshot.contentPostId) continue;
      if (!latestByPost.has(snapshot.contentPostId)) latestByPost.set(snapshot.contentPostId, snapshot);
    }

    const metricRows = await this.deps.analyticsRepository.listMetricsForSnapshots(
      [...latestByPost.values()].map((s) => s.id),
    );

    const metricsBySnapshot = new Map<string, NormalizedMetric[]>();
    for (const row of metricRows) {
      const list = metricsBySnapshot.get(row.snapshotId) ?? [];
      list.push({
        name: row.metricName,
        platformName: row.platformMetricName ?? row.metricName,
        value: row.metricValue === null ? undefined : Number(row.metricValue),
        unit: row.metricUnit,
        available: row.available,
        unavailableReason: row.unavailableReason ?? undefined,
        source: (row.source as "platform" | "derived") ?? "platform",
        computation: (row.computation as NormalizedMetric["computation"]) ?? undefined,
      });
      metricsBySnapshot.set(row.snapshotId, list);
    }

    return [...latestByPost.values()].map((snapshot) => ({
      snapshot,
      metrics: metricsBySnapshot.get(snapshot.id) ?? [],
    }));
  }

  async getAccountBaseline(socialAccountId: string): Promise<AccountBaseline> {
    const performance = await this.getPostPerformance(socialAccountId, 100);
    const samples = performance.map((entry) => ({
      contentPostId: entry.snapshot.contentPostId!,
      metrics: Object.fromEntries(entry.metrics.map((m) => [m.name, m.available ? m.value : undefined])),
    }));
    return calculateAccountBaseline(samples, this.deps.baselinePostCount ?? 10);
  }

  /** Follower history as a time series, oldest first. Never derived from a single current value. */
  async getGrowthSeries(socialAccountId: string) {
    const snapshots = await this.deps.analyticsRepository.listAccountSnapshots(socialAccountId);
    const metricRows = await this.deps.analyticsRepository.listMetricsForSnapshots(snapshots.map((s) => s.id));

    const followersBySnapshot = new Map<string, number | undefined>();
    for (const row of metricRows) {
      if (row.metricName === "followers" && row.available && row.metricValue !== null) {
        followersBySnapshot.set(row.snapshotId, Number(row.metricValue));
      }
    }

    const series = snapshots.map((snapshot) => ({
      capturedAt: snapshot.capturedAt.toISOString(),
      day: snapshot.collectionWindow,
      followers: followersBySnapshot.get(snapshot.id),
    }));

    const withFollowers = series.filter((point) => point.followers !== undefined);
    const first = withFollowers[0]?.followers;
    const last = withFollowers[withFollowers.length - 1]?.followers;

    return {
      series,
      current: last,
      // Only a real difference between two observed snapshots — never inferred.
      change: first !== undefined && last !== undefined && withFollowers.length > 1 ? last - first : undefined,
      observations: withFollowers.length,
    };
  }

  async getPostAnalytics(contentPostId: string) {
    const state = await this.deps.analyticsRepository.findStateByPost(contentPostId);
    const snapshots = await this.deps.analyticsRepository.listSnapshotsForPost(contentPostId);
    const latest = snapshots[snapshots.length - 1];
    const metrics = latest ? await this.deps.analyticsRepository.listMetricsForSnapshot(latest.id) : [];

    return { state, snapshots, latest, metrics };
  }

  scorePost(postMetrics: Record<string, number | undefined>, baseline: AccountBaseline) {
    return calculatePerformanceScore(postMetrics, baseline, this.deps.performanceWeights ?? DEFAULT_PERFORMANCE_WEIGHTS);
  }

  // --- internals ---

  private async resolveConnection(
    socialAccountId: string,
  ): Promise<{ accessToken: string; connectionId: string; platformAccountId: string } | { reason: string }> {
    const connection = await this.deps.socialConnectionRepository.findActiveForAccount(socialAccountId, "instagram");
    if (!connection) return { reason: "No connected Instagram account — reconnect to resume analytics" };

    const withSecrets = await this.deps.socialConnectionRepository.findByIdWithSecrets(connection.id);
    if (!withSecrets?.accessTokenEncrypted) return { reason: "The connection has no stored credential" };
    if (!this.deps.tokenEncryption) return { reason: "Token encryption is not configured" };

    try {
      return {
        accessToken: this.deps.tokenEncryption.decrypt(withSecrets.accessTokenEncrypted),
        connectionId: connection.id,
        platformAccountId: withSecrets.platformAccountId,
      };
    } catch {
      // Never propagate the underlying error: it could carry ciphertext.
      return { reason: "The stored credential could not be read — reconnect the account" };
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof PublishingError) return RETRYABLE_CODES.has(error.publishingErrorCode);
    return true; // unknown transport failures get bounded retries
  }

  private async failCollection(
    contentPostId: string,
    reason: string,
    retryable: boolean,
    previousAttempts: string | number = 0,
  ): Promise<CollectionResult> {
    const attempts = Number(previousAttempts) + 1;
    const maxAttempts = this.deps.maxCollectionAttempts ?? 3;
    const exhausted = attempts >= maxAttempts;

    // A non-retryable failure clears nextSnapshotAt so the worker stops
    // selecting it — this is what prevents endless retries of a disconnected
    // account.
    await this.deps.analyticsRepository.updateState(contentPostId, {
      status: "failed",
      attempts,
      lastError: reason,
      nextSnapshotAt: !retryable || exhausted ? null : new Date(Date.now() + 15 * 60_000),
    });

    this.deps.logger.warn({ contentPostId, reason, retryable, attempts }, "analytics.collection_failed");
    return { contentPostId, status: "failed", reason };
  }
}

function toMetricInput(metric: NormalizedMetric) {
  return {
    metricName: metric.name,
    platformMetricName: metric.platformName,
    metricValue: metric.value,
    metricUnit: metric.unit,
    available: metric.available,
    unavailableReason: metric.unavailableReason,
    source: metric.source,
    computation: metric.computation as Record<string, unknown> | undefined,
  };
}

function describeError(error: unknown): string {
  if (error instanceof PublishingError || error instanceof AppError) return error.message;
  return "Analytics collection failed";
}

export { metricValue };
