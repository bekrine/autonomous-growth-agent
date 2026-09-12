import { and, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import {
  analyticsInsights,
  analyticsMetrics,
  analyticsSnapshots,
  contentAnalyticsState,
  contentIdeas,
  contentPosts,
} from "../schema/index.js";

export interface RecordSnapshotInput {
  socialAccountId: string;
  contentPostId?: string | null;
  contentGenerationId?: string | null;
  socialConnectionId?: string | null;
  platform?: string;
  externalPostId?: string | null;
  metricType: string;
  collectionWindow: string;
  metrics: Record<string, unknown>;
  capturedAt: Date;
  outcome: string;
  errorReason?: string | null;
}

export interface NormalizedMetricInput {
  metricName: string;
  platformMetricName?: string;
  metricValue?: number;
  metricUnit?: string;
  available: boolean;
  unavailableReason?: string;
  source?: "platform" | "derived";
  computation?: Record<string, unknown>;
}

export class AnalyticsRepository {
  constructor(private readonly db: DrizzleClient) {}

  async listForAccount(socialAccountId: string, limit = 100) {
    return this.db
      .select()
      .from(analyticsSnapshots)
      .where(eq(analyticsSnapshots.socialAccountId, socialAccountId))
      .orderBy(desc(analyticsSnapshots.capturedAt))
      .limit(limit);
  }

  /** Phase 1 signature, retained so existing callers keep working. */
  async record(input: {
    socialAccountId: string;
    contentPostId?: string;
    metricType: string;
    metrics: Record<string, unknown>;
    capturedAt: Date;
  }) {
    const [row] = await this.db.insert(analyticsSnapshots).values(input).returning();
    return row;
  }

  /**
   * Idempotent insert. The UNIQUE (account, post, type, window) constraint is
   * the real guard — a redelivered job hits the conflict and returns the
   * existing row rather than duplicating history.
   */
  async recordSnapshotIfAbsent(input: RecordSnapshotInput): Promise<{ snapshot: typeof analyticsSnapshots.$inferSelect; created: boolean }> {
    const [inserted] = await this.db
      .insert(analyticsSnapshots)
      .values({
        socialAccountId: input.socialAccountId,
        contentPostId: input.contentPostId ?? null,
        contentGenerationId: input.contentGenerationId ?? null,
        socialConnectionId: input.socialConnectionId ?? null,
        platform: input.platform,
        externalPostId: input.externalPostId ?? null,
        metricType: input.metricType,
        collectionWindow: input.collectionWindow,
        metrics: input.metrics,
        capturedAt: input.capturedAt,
        outcome: input.outcome,
        errorReason: input.errorReason ?? null,
      })
      .onConflictDoNothing({
        target: [
          analyticsSnapshots.socialAccountId,
          analyticsSnapshots.contentPostId,
          analyticsSnapshots.metricType,
          analyticsSnapshots.collectionWindow,
        ],
      })
      .returning();

    if (inserted) return { snapshot: inserted, created: true };

    const [existing] = await this.db
      .select()
      .from(analyticsSnapshots)
      .where(
        and(
          eq(analyticsSnapshots.socialAccountId, input.socialAccountId),
          input.contentPostId
            ? eq(analyticsSnapshots.contentPostId, input.contentPostId)
            : sql`${analyticsSnapshots.contentPostId} is null`,
          eq(analyticsSnapshots.metricType, input.metricType),
          eq(analyticsSnapshots.collectionWindow, input.collectionWindow),
        ),
      );

    return { snapshot: existing!, created: false };
  }

  async saveMetrics(snapshotId: string, metrics: NormalizedMetricInput[]) {
    if (metrics.length === 0) return [];
    return this.db
      .insert(analyticsMetrics)
      .values(
        metrics.map((metric) => ({
          snapshotId,
          metricName: metric.metricName,
          platformMetricName: metric.platformMetricName ?? null,
          // numeric columns round-trip as strings in pg.
          metricValue: metric.metricValue === undefined ? null : String(metric.metricValue),
          metricUnit: metric.metricUnit ?? "count",
          available: metric.available,
          unavailableReason: metric.unavailableReason ?? null,
          source: metric.source ?? "platform",
          computation: metric.computation ?? null,
        })),
      )
      .onConflictDoNothing({ target: [analyticsMetrics.snapshotId, analyticsMetrics.metricName] })
      .returning();
  }

  async listMetricsForSnapshot(snapshotId: string) {
    return this.db.select().from(analyticsMetrics).where(eq(analyticsMetrics.snapshotId, snapshotId));
  }

  /** Latest snapshot per content post, which is what "current performance" means. */
  async findLatestSnapshotForPost(contentPostId: string, metricType = "media") {
    const [row] = await this.db
      .select()
      .from(analyticsSnapshots)
      .where(and(eq(analyticsSnapshots.contentPostId, contentPostId), eq(analyticsSnapshots.metricType, metricType)))
      .orderBy(desc(analyticsSnapshots.capturedAt))
      .limit(1);
    return row ?? null;
  }

  async listSnapshotsForPost(contentPostId: string) {
    return this.db
      .select()
      .from(analyticsSnapshots)
      .where(eq(analyticsSnapshots.contentPostId, contentPostId))
      .orderBy(analyticsSnapshots.capturedAt);
  }

  /** Account snapshots ordered oldest-first — the follower history series. */
  async listAccountSnapshots(socialAccountId: string, limit = 365) {
    return this.db
      .select()
      .from(analyticsSnapshots)
      .where(and(eq(analyticsSnapshots.socialAccountId, socialAccountId), eq(analyticsSnapshots.metricType, "account")))
      .orderBy(analyticsSnapshots.capturedAt)
      .limit(limit);
  }

  async listLatestPostSnapshots(socialAccountId: string, limit = 50) {
    return this.db
      .select()
      .from(analyticsSnapshots)
      .where(
        and(
          eq(analyticsSnapshots.socialAccountId, socialAccountId),
          eq(analyticsSnapshots.metricType, "media"),
          isNotNull(analyticsSnapshots.contentPostId),
        ),
      )
      .orderBy(desc(analyticsSnapshots.capturedAt))
      .limit(limit);
  }

  async listMetricsForSnapshots(snapshotIds: string[]) {
    if (snapshotIds.length === 0) return [];
    return this.db.select().from(analyticsMetrics).where(inArray(analyticsMetrics.snapshotId, snapshotIds));
  }

  // --- collection state ---

  async upsertState(input: {
    contentPostId: string;
    socialAccountId: string;
    externalPostId?: string | null;
    platform?: string;
    publishedAt?: Date | null;
    nextSnapshotAt?: Date | null;
    status?: string;
  }) {
    const [row] = await this.db
      .insert(contentAnalyticsState)
      .values({
        contentPostId: input.contentPostId,
        socialAccountId: input.socialAccountId,
        externalPostId: input.externalPostId ?? null,
        platform: input.platform,
        publishedAt: input.publishedAt ?? null,
        nextSnapshotAt: input.nextSnapshotAt ?? null,
        status: input.status ?? "pending",
      })
      .onConflictDoUpdate({
        target: contentAnalyticsState.contentPostId,
        set: {
          externalPostId: input.externalPostId ?? null,
          platform: input.platform,
          publishedAt: input.publishedAt ?? null,
          nextSnapshotAt: input.nextSnapshotAt ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async findStateByPost(contentPostId: string) {
    const [row] = await this.db
      .select()
      .from(contentAnalyticsState)
      .where(eq(contentAnalyticsState.contentPostId, contentPostId));
    return row ?? null;
  }

  /**
   * Only posts genuinely due for collection. This query is the cost control:
   * without the `nextSnapshotAt <= now` filter the worker would poll every
   * published post forever.
   */
  async listDueForCollection(now: Date, limit = 25) {
    return this.db
      .select()
      .from(contentAnalyticsState)
      .where(
        and(
          isNotNull(contentAnalyticsState.externalPostId),
          isNotNull(contentAnalyticsState.nextSnapshotAt),
          lte(contentAnalyticsState.nextSnapshotAt, now),
          or(
            eq(contentAnalyticsState.status, "pending"),
            eq(contentAnalyticsState.status, "partial"),
            eq(contentAnalyticsState.status, "up_to_date"),
            eq(contentAnalyticsState.status, "failed"),
          ),
        ),
      )
      .orderBy(contentAnalyticsState.nextSnapshotAt)
      .limit(limit);
  }

  async updateState(
    contentPostId: string,
    update: {
      status?: string;
      lastSnapshotAt?: Date | null;
      nextSnapshotAt?: Date | null;
      completedWindows?: string[];
      attempts?: number;
      lastError?: string | null;
    },
  ) {
    const [row] = await this.db
      .update(contentAnalyticsState)
      .set({
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.lastSnapshotAt !== undefined ? { lastSnapshotAt: update.lastSnapshotAt } : {}),
        ...(update.nextSnapshotAt !== undefined ? { nextSnapshotAt: update.nextSnapshotAt } : {}),
        ...(update.completedWindows !== undefined ? { completedWindows: update.completedWindows } : {}),
        ...(update.attempts !== undefined ? { attempts: String(update.attempts) } : {}),
        ...(update.lastError !== undefined ? { lastError: update.lastError } : {}),
        updatedAt: new Date(),
      })
      .where(eq(contentAnalyticsState.contentPostId, contentPostId))
      .returning();
    return row;
  }

  async listStatesForAccount(socialAccountId: string) {
    return this.db
      .select()
      .from(contentAnalyticsState)
      .where(eq(contentAnalyticsState.socialAccountId, socialAccountId));
  }

  // --- insights ---

  async saveInsights(
    inputs: {
      socialAccountId: string;
      agentRunId?: string | null;
      insightType: string;
      dimension?: string | null;
      dimensionValue?: string | null;
      finding: string;
      evidence?: Record<string, unknown>;
      confidence?: number;
      sampleSize?: number;
      timeRangeStart?: Date | null;
      timeRangeEnd?: Date | null;
    }[],
  ) {
    if (inputs.length === 0) return [];
    return this.db
      .insert(analyticsInsights)
      .values(
        inputs.map((input) => ({
          socialAccountId: input.socialAccountId,
          agentRunId: input.agentRunId ?? null,
          insightType: input.insightType,
          dimension: input.dimension ?? null,
          dimensionValue: input.dimensionValue ?? null,
          finding: input.finding,
          evidence: input.evidence ?? null,
          confidence: input.confidence === undefined ? null : String(input.confidence),
          sampleSize: input.sampleSize === undefined ? null : String(input.sampleSize),
          timeRangeStart: input.timeRangeStart ?? null,
          timeRangeEnd: input.timeRangeEnd ?? null,
        })),
      )
      .returning();
  }

  async listInsights(socialAccountId: string, limit = 50) {
    return this.db
      .select()
      .from(analyticsInsights)
      .where(eq(analyticsInsights.socialAccountId, socialAccountId))
      .orderBy(desc(analyticsInsights.createdAt))
      .limit(limit);
  }

  /**
   * Published posts joined to the idea that produced them, because the
   * dimensions insights are grouped by (format, pillar, topic) live on
   * content_ideas — not on the post row.
   */
  async listPublishedPostsWithDimensions(socialAccountId: string, limit = 100) {
    const rows = await this.db
      .select({
        id: contentPosts.id,
        contentIdeaId: contentPosts.contentIdeaId,
        publishedAt: contentPosts.publishedAt,
        currentGenerationVersion: contentPosts.currentGenerationVersion,
        experimentId: contentPosts.experimentId,
        experimentVariantId: contentPosts.experimentVariantId,
        title: contentIdeas.title,
        format: contentIdeas.format,
        contentPillar: contentIdeas.contentPillar,
        hook: contentIdeas.hook,
        objective: contentIdeas.objective,
      })
      .from(contentPosts)
      .leftJoin(contentIdeas, eq(contentPosts.contentIdeaId, contentIdeas.id))
      .where(and(eq(contentPosts.socialAccountId, socialAccountId), eq(contentPosts.status, "published")))
      .orderBy(desc(contentPosts.publishedAt))
      .limit(limit);
    return rows;
  }
}
