import { NotFoundError, AppError } from "@agent/shared";
import type {
  AgentProfileRepository,
  AnalyticsRepository,
  ContentRepository,
  ExperimentRepository,
  ResearchRepository,
  SocialAccountRepository,
  StrategyRepository,
} from "@agent/database";
import type { KillSwitchStore } from "@agent/policies";
import type { AgentContextData } from "./types.js";

export interface AgentContextLoaderDeps {
  socialAccountRepository: SocialAccountRepository;
  agentProfileRepository: AgentProfileRepository;
  strategyRepository: StrategyRepository;
  contentRepository: ContentRepository;
  analyticsRepository: AnalyticsRepository;
  experimentRepository: ExperimentRepository;
  researchRepository: ResearchRepository;
  killSwitch: KillSwitchStore;
}

/** The account exists but has no agent_profiles row yet — bootstrap one before running agents. */
export class AgentProfileMissingError extends AppError {
  constructor(accountId: string) {
    super(`Account ${accountId} has no agent profile yet — create one before starting a run`, {
      statusCode: 422,
      code: "AGENT_PROFILE_MISSING",
    });
  }
}

/**
 * Assembles the full read-only state an agent run needs before any agent
 * executes, so individual agents never query a repository themselves. One
 * loader call per run; the result is reused (with `research` refreshed
 * where relevant) across every agent in that run's context.
 */
export class AgentContextLoader {
  constructor(private readonly deps: AgentContextLoaderDeps) {}

  async load(accountId: string): Promise<AgentContextData> {
    const {
      socialAccountRepository,
      agentProfileRepository,
      strategyRepository,
      contentRepository,
      analyticsRepository,
      experimentRepository,
      researchRepository,
      killSwitch,
    } = this.deps;

    const account = await socialAccountRepository.findById(accountId);
    if (!account) throw new NotFoundError("SocialAccount", accountId);

    const profile = await agentProfileRepository.findBySocialAccountId(accountId);
    if (!profile) throw new AgentProfileMissingError(accountId);

    const goalRow = await agentProfileRepository.findActiveGoal(profile.id);

    const [strategies, recentPosts, recentAnalytics, experiments, recentResearch] = await Promise.all([
      strategyRepository.findByAgentProfileId(profile.id),
      contentRepository.listRecentPostsByAccount(accountId, 20),
      analyticsRepository.listForAccount(accountId, 20),
      experimentRepository.listForAccount(accountId),
      researchRepository.listRecentByAccount(accountId, 20),
    ]);

    let currentStrategy: AgentContextData["currentStrategy"] = null;
    let previousStrategyVersions: AgentContextData["previousStrategyVersions"] = [];

    const strategy = strategies[0];
    if (strategy) {
      const versions = await strategyRepository.listVersions(strategy.id);
      const latest = versions[versions.length - 1];
      if (latest) {
        currentStrategy = {
          strategyId: strategy.id,
          versionId: latest.id,
          versionNumber: latest.versionNumber,
          summary: latest.summary,
          data: latest.content as Record<string, unknown>,
        };
      }
      previousStrategyVersions = versions.map((v) => ({
        versionNumber: v.versionNumber,
        summary: v.summary,
        createdAt: v.createdAt.toISOString(),
      }));
    }

    return {
      account: {
        id: account.id,
        platform: account.platform,
        displayName: account.displayName,
        niche: profile.niche,
        targetAudience: profile.audienceDescription,
        tone: profile.tone,
      },
      goal: goalRow
        ? {
            id: goalRow.id,
            title: goalRow.title,
            metric: goalRow.metric,
            targetValue: goalRow.targetValue ? Number(goalRow.targetValue) : null,
            status: goalRow.status,
          }
        : null,
      currentStrategy,
      recentContent: recentPosts.map((p) => ({
        id: p.id,
        title: p.caption ?? "(untitled)",
        status: p.status,
        format: null,
        contentPillar: null,
        createdAt: p.createdAt.toISOString(),
      })),
      recentAnalytics: recentAnalytics.map((a) => ({
        contentPostId: a.contentPostId,
        metricType: a.metricType,
        metrics: a.metrics as Record<string, unknown>,
        capturedAt: a.capturedAt.toISOString(),
      })),
      previousStrategyVersions,
      activeExperiments: experiments
        .map((e) => e.experiment)
        .filter((e) => e.status === "running")
        .map((e) => ({ id: e.id, name: e.name, status: e.status, hypothesis: e.hypothesis })),
      research: recentResearch.map((r) => ({
        topic: r.topic,
        relevanceScore: Number(r.relevanceScore),
        createdAt: r.createdAt.toISOString(),
      })),
      policies: {
        autonomyEnabled: !killSwitch.isDisabled(accountId),
        contentApprovalRequired: true,
      },
      agentProfileId: profile.id,
    };
  }
}
