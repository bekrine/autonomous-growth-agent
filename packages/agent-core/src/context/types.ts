import type { SocialPlatformName } from "@agent/shared";

/**
 * Domain-shaped context types assembled by AgentContextLoader. These are
 * deliberately not the raw Drizzle row types from @agent/database — agents
 * see only what they need, in a stable shape, so a schema column rename
 * never forces every agent to change.
 */

export interface AccountContext {
  id: string;
  platform: SocialPlatformName;
  displayName: string;
  niche: string;
  targetAudience: string | null;
  tone: string | null;
}

export interface AgentGoalContext {
  id: string;
  title: string;
  metric: string;
  targetValue: number | null;
  status: string;
}

export interface StrategyContext {
  strategyId: string;
  versionId: string;
  versionNumber: number;
  summary: string;
  data: Record<string, unknown>;
}

export interface StrategyVersionSummary {
  versionNumber: number;
  summary: string;
  createdAt: string;
}

export interface RecentContentSummary {
  id: string;
  title: string;
  status: string;
  format: string | null;
  contentPillar: string | null;
  createdAt: string;
}

export interface RecentAnalyticsSummary {
  contentPostId: string | null;
  metricType: string;
  metrics: Record<string, unknown>;
  capturedAt: string;
}

export interface ExperimentSummary {
  id: string;
  name: string;
  status: string;
  hypothesis: string | null;
}

/** Topics surfaced by earlier runs — given to ResearchAgent so it doesn't re-propose the same topic every run. */
export interface ResearchSignalSummary {
  topic: string;
  relevanceScore: number;
  createdAt: string;
}

/** Shape of the measured data handed to AnalyticsAgent. Mirrors AnalyticsPromptInput. */
export interface AnalyticsAgentInput {
  niche: string | null;
  targetAudience: string | null;
  postCount: number;
  baselineSampleSize: number;
  baseline: Record<string, number>;
  posts: {
    format: string | null;
    contentPillar: string | null;
    title: string | null;
    publishedAt: string | null;
    postingHourUtc: number | null;
    postingDayUtc: string | null;
    generationVersion: number | null;
    metrics: Record<string, number | undefined>;
    performanceScore?: number;
  }[];
  followerChange?: number;
  unavailableMetrics: string[];
}

export interface AgentPolicyContext {
  autonomyEnabled: boolean;
  contentApprovalRequired: boolean;
}

/**
 * Everything AgentContextLoader assembles before a run starts. The
 * orchestrator merges this with per-run fields (runId, logger, llm, tools,
 * previousResults) to build the full AgentContext passed to each agent.
 */
export interface AgentContextData {
  account: AccountContext;
  /**
   * Pre-computed analytics for AnalyticsAgent (Phase 5). Deterministic
   * numbers produced by AnalyticsService from stored snapshots — the agent
   * interprets them and never fetches anything itself. Absent when no
   * analysis was requested.
   */
  analyticsInput?: AnalyticsAgentInput;
  goal: AgentGoalContext | null;
  currentStrategy: StrategyContext | null;
  recentContent: RecentContentSummary[];
  recentAnalytics: RecentAnalyticsSummary[];
  previousStrategyVersions: StrategyVersionSummary[];
  activeExperiments: ExperimentSummary[];
  research: ResearchSignalSummary[];
  policies: AgentPolicyContext;
  /** Internal: the agent_profiles row id backing `account`, needed by the orchestrator's persistence layer. */
  agentProfileId: string;
}
