import type { AnalyticsRepository, AgentProfileRepository, SocialAccountRepository } from "@agent/database";
import type { AnalyticsService } from "./analytics-service.js";
import type { AnalyticsAgentInput } from "../context/types.js";

/**
 * Assembles the measured inputs the AnalyticsAgent reasons over.
 *
 * Everything here is deterministic: metrics come from stored snapshots, the
 * baseline is a median, and the performance score is arithmetic. The agent
 * receives finished numbers and only explains them — it never fetches, never
 * computes, and has no route to Meta.
 */
export async function buildAnalyticsAgentInput(deps: {
  analyticsService: AnalyticsService;
  analyticsRepository: AnalyticsRepository;
  socialAccountRepository: SocialAccountRepository;
  agentProfileRepository: AgentProfileRepository;
  socialAccountId: string;
}): Promise<AnalyticsAgentInput> {
  const { analyticsService, analyticsRepository, agentProfileRepository, socialAccountId } = deps;

  const [performance, baseline, growth, posts, profile] = await Promise.all([
    analyticsService.getPostPerformance(socialAccountId, 50),
    analyticsService.getAccountBaseline(socialAccountId),
    analyticsService.getGrowthSeries(socialAccountId),
    analyticsRepository.listPublishedPostsWithDimensions(socialAccountId, 200),
    agentProfileRepository.findBySocialAccountId(socialAccountId),
  ]);

  const postsById = new Map(posts.map((post) => [post.id, post]));
  const unavailable = new Set<string>();

  const entries = performance.map((entry) => {
    const metrics: Record<string, number | undefined> = {};
    for (const metric of entry.metrics) {
      if (metric.available) metrics[metric.name] = metric.value;
      else unavailable.add(metric.name);
    }

    const post = entry.snapshot.contentPostId ? postsById.get(entry.snapshot.contentPostId) : undefined;
    const publishedAt = post?.publishedAt ?? null;
    const score = analyticsService.scorePost(metrics, baseline);

    return {
      format: post?.format ?? null,
      contentPillar: post?.contentPillar ?? null,
      title: post?.title ?? null,
      publishedAt: publishedAt ? publishedAt.toISOString() : null,
      // UTC consistently — a "best posting hour" that silently mixes
      // timezones would be meaningless.
      postingHourUtc: publishedAt ? publishedAt.getUTCHours() : null,
      postingDayUtc: publishedAt ? UTC_DAYS[publishedAt.getUTCDay()]! : null,
      generationVersion: post?.currentGenerationVersion ?? null,
      metrics,
      performanceScore: score.available ? score.score : undefined,
    };
  });

  return {
    niche: profile?.niche ?? null,
    targetAudience: profile?.audienceDescription ?? null,
    postCount: entries.length,
    baselineSampleSize: baseline.sampleSize,
    baseline: baseline.metrics,
    posts: entries,
    followerChange: growth.change,
    // Named explicitly so the agent can say "not available" instead of guessing.
    unavailableMetrics: [...unavailable],
  };
}

const UTC_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
