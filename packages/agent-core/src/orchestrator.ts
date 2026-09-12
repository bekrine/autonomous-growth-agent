import {
  AgentRunRepository,
  ContentGenerationRepository,
  ContentRepository,
  ResearchRepository,
  StrategyRepository,
  type AgentProfileRepository,
  type AnalyticsRepository,
  type Database,
  type DrizzleClient,
  type SocialAccountRepository,
} from "@agent/database";
import type { AgentName, Logger } from "@agent/shared";
import { NotFoundError } from "@agent/shared";
import type { LLMProvider } from "@agent/llm";
import type { Agent, AgentContext, AgentResult, TargetContentIdeaContext } from "./types.js";
import type { ToolRouter } from "./tool-router.js";
import type { ToolResult } from "./tool.js";
import type { AgentContextLoader } from "./context/agent-context-loader.js";
import type { AgentContextData } from "./context/types.js";
import type { ResearchResult } from "./prompts/research.prompt.js";
import type { StrategyResult } from "./prompts/strategy.prompt.js";
import type { ContentPlanResult } from "./prompts/content-planner.prompt.js";
import type { GeneratedContent } from "./prompts/content-creator/index.js";
import type { ReviewResult } from "./prompts/reviewer/index.js";
import type { AnalyticsInsightResult } from "./prompts/analytics/index.js";
import type { AnalyticsService } from "./analytics/analytics-service.js";
import { buildAnalyticsAgentInput } from "./analytics/performance-analysis.js";

export interface OrchestratorDependencies {
  db: Database;
  contextLoader: AgentContextLoader;
  agentRunRepository: AgentRunRepository;
  researchRepository: ResearchRepository;
  strategyRepository: StrategyRepository;
  contentRepository: ContentRepository;
  contentGenerationRepository: ContentGenerationRepository;
  toolRouter: ToolRouter;
  llm: LLMProvider;
  logger: Logger;
  /** Hard ceiling on regeneration attempts per content post — never an infinite loop. */
  maxRegenerationAttempts: number;
  /** Recorded on the asset row up-front so a failed generation still says which provider was attempted. */
  imageGeneratorName: string;
}

/** Data the analytics path needs; separate from OrchestratorDependencies so the rest stays untouched. */
export interface OrchestratorAnalyticsDependencies {
  analyticsService: AnalyticsService;
  analyticsRepository: AnalyticsRepository;
  socialAccountRepository: SocialAccountRepository;
  agentProfileRepository: AgentProfileRepository;
}

export interface AnalyticsAnalysisOutcome {
  runId: string;
  status: "completed" | "failed";
  postCount: number;
  insights?: AnalyticsInsightResult;
  error?: string;
}

export interface AgentRunOutcome {
  runId: string;
  status: "completed" | "failed";
  error?: string;
}

export interface ContentGenerationOutcome {
  runId: string;
  contentPostId: string;
  status: "ready_for_publishing" | "review_failed" | "generation_failed";
  generationVersion: number;
  error?: string;
}

/**
 * Executes the fixed Research -> Strategy -> ContentPlanner pipeline for
 * one run:
 *   resolve run (new or resumed) -> load account context once ->
 *   run each agent in order, feeding each agent's result forward via
 *   previousResults -> persist decisions/actions/domain rows for each
 *   stage (transactionally, idempotently) -> mark run complete.
 *
 * Also executes the Phase 3 content-generation pipeline for a single idea
 * (`generateContent`): ContentCreator -> media generation -> Reviewer,
 * looped up to `maxRegenerationAttempts` times until approved.
 *
 * Persistence lives here, not in the agents (rule: agents never touch a
 * repository) and not in the caller (AgentRunService only starts/reads
 * runs) — this is the single place an AgentResult becomes database rows.
 */
export class AgentOrchestrator {
  constructor(
    private readonly deps: OrchestratorDependencies,
    private readonly agents: Agent[],
    private readonly contentAgents: { contentCreator: Agent; reviewer: Agent },
    private readonly analyticsAgent?: Agent,
    private readonly analyticsDeps?: OrchestratorAnalyticsDependencies,
  ) {}

  /**
   * `options.runId` lets a caller (typically the BullMQ job processor)
   * resume/retry a specific run instead of always creating a new one — a
   * redelivered job for an already-completed run is a no-op, and a retry
   * of a partially-completed run will not duplicate rows already written,
   * because every persistence step below checks for existing rows first.
   */
  async executeRun(accountId: string, options: { runId?: string } = {}): Promise<AgentRunOutcome> {
    const { agentRunRepository, contextLoader, toolRouter, llm, logger } = this.deps;

    const run = options.runId
      ? await agentRunRepository.findById(options.runId)
      : await agentRunRepository.create(accountId);

    if (!run) throw new NotFoundError("AgentRun", options.runId!);

    if (run.status === "completed") {
      logger.info({ runId: run.id }, "agent_run.already_completed_skip");
      return { runId: run.id, status: "completed" };
    }

    await agentRunRepository.markRunning(run.id);
    logger.info({ runId: run.id, accountId }, "agent_run.started");

    try {
      const contextData = await contextLoader.load(accountId);
      const previousResults: Partial<Record<AgentName, AgentResult>> = {};
      let currentStrategyVersionId = contextData.currentStrategy?.versionId;

      for (const agent of this.agents) {
        const context: AgentContext = {
          ...contextData,
          runId: run.id,
          accountId,
          logger,
          llm,
          tools: toolRouter,
          previousResults,
          targetContentIdea: null,
          regenerationFeedback: [],
        };

        const result = await agent.run(context);
        previousResults[agent.name] = result;

        if (agent.name === "research") {
          await this.persistResearchResult(run.id, accountId, result);
        } else if (agent.name === "strategy") {
          currentStrategyVersionId = await this.persistStrategyResult(run.id, contextData, result);
        } else if (agent.name === "content_planner") {
          await this.persistContentPlanResult(run.id, contextData.agentProfileId, result, currentStrategyVersionId);
        } else {
          await this.persistGenericResult(run.id, agent.name, result);
        }
      }

      await agentRunRepository.markFinished(run.id, "completed");
      logger.info({ runId: run.id }, "agent_run.completed");
      return { runId: run.id, status: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await agentRunRepository.markFinished(run.id, "failed", message);
      logger.error({ runId: run.id, error: message }, "agent_run.failed");
      return { runId: run.id, status: "failed", error: message };
    }
  }

  /**
   * ContentCreator -> media generation -> Reviewer, looped until approved
   * or `maxRegenerationAttempts` is exhausted. One content_post per idea
   * (found-or-created); each attempt is its own content_generations
   * version — never overwritten, always the full history.
   */
  async generateContent(
    accountId: string,
    contentIdeaId: string,
    options: { runId?: string } = {},
  ): Promise<ContentGenerationOutcome> {
    const { agentRunRepository, contentRepository, contentGenerationRepository, contextLoader, toolRouter, llm, logger, maxRegenerationAttempts } =
      this.deps;

    const idea = await contentRepository.findIdeaById(contentIdeaId);
    if (!idea) throw new NotFoundError("ContentIdea", contentIdeaId);

    let post = await contentRepository.findPostByIdeaId(contentIdeaId);
    if (!post) {
      post = await contentRepository.createPost({ socialAccountId: accountId, contentIdeaId, status: "brief_created" });
    }

    if (post.status === "ready_for_publishing" || post.status === "review_failed") {
      logger.info({ contentPostId: post.id, status: post.status }, "content_generation.already_terminal_skip");
      return {
        runId: options.runId ?? "",
        contentPostId: post.id,
        status: post.status,
        generationVersion: post.currentGenerationVersion,
      };
    }

    const run = options.runId
      ? await agentRunRepository.findById(options.runId)
      : await agentRunRepository.create(accountId);
    if (!run) throw new NotFoundError("AgentRun", options.runId!);

    await agentRunRepository.markRunning(run.id);
    await contentRepository.updatePostStatus(post.id, "generating");
    logger.info({ runId: run.id, contentPostId: post.id, contentIdeaId }, "content_generation.started");

    const targetContentIdea: TargetContentIdeaContext = {
      id: idea.id,
      title: idea.title,
      format: idea.format,
      contentPillar: idea.contentPillar,
      targetAudience: idea.targetAudience,
      hook: idea.hook,
      objective: idea.objective,
    };

    try {
      const contextData = await contextLoader.load(accountId);
      let regenerationFeedback: string[] = [];

      for (let attempt = 1; attempt <= maxRegenerationAttempts; attempt++) {
        const previousResults: Partial<Record<AgentName, AgentResult>> = {};
        const buildContext = (): AgentContext => ({
          ...contextData,
          runId: run.id,
          accountId,
          logger,
          llm,
          tools: toolRouter,
          previousResults,
          targetContentIdea,
          regenerationFeedback,
        });

        const creatorResult = await this.contentAgents.contentCreator.run(buildContext());
        previousResults.content_creator = creatorResult;
        const generatedContent = creatorResult.data?.generatedContent as GeneratedContent | undefined;
        if (!generatedContent) {
          throw new Error("ContentCreatorAgent did not return generatedContent");
        }

        const generation = await this.persistGenerationAttempt(run.id, post.id, attempt, creatorResult, generatedContent);

        if (generatedContent.format !== "text") {
          await this.generateAndPersistCoverImage(accountId, post.id, generation.id, generatedContent);
        }

        const reviewerResult = await this.contentAgents.reviewer.run(buildContext());
        previousResults.reviewer = reviewerResult;
        const review = reviewerResult.data?.review as ReviewResult | undefined;
        if (!review) {
          throw new Error("ReviewerAgent did not return a review");
        }

        await this.persistReviewResult(run.id, generation.id, reviewerResult, review);
        await contentRepository.incrementGenerationAttempts(post.id);

        if (review.approved) {
          await contentRepository.setCurrentGenerationVersion(post.id, attempt);
          await contentRepository.updatePostStatus(post.id, "ready_for_publishing");
          await agentRunRepository.markFinished(run.id, "completed");
          logger.info({ runId: run.id, contentPostId: post.id, version: attempt }, "content_generation.approved");
          return { runId: run.id, contentPostId: post.id, status: "ready_for_publishing", generationVersion: attempt };
        }

        regenerationFeedback = review.recommendedChanges;
        const isLastAttempt = attempt === maxRegenerationAttempts;
        await contentRepository.updatePostStatus(post.id, isLastAttempt ? "review_failed" : "reviewing");
        logger.info(
          { runId: run.id, contentPostId: post.id, attempt, approved: false, isLastAttempt },
          "content_generation.review_rejected",
        );
      }

      await agentRunRepository.markFinished(run.id, "completed");
      return {
        runId: run.id,
        contentPostId: post.id,
        status: "review_failed",
        generationVersion: maxRegenerationAttempts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await contentRepository.updatePostStatus(post.id, "generation_failed");
      await agentRunRepository.markFinished(run.id, "failed", message);
      logger.error({ runId: run.id, contentPostId: post.id, error: message }, "content_generation.failed");
      return { runId: run.id, contentPostId: post.id, status: "generation_failed", generationVersion: post.currentGenerationVersion, error: message };
    }
  }

  /**
   * Runs the AnalyticsAgent over already-measured data.
   *
   * A separate entry point from executeRun on purpose: this is interpretation,
   * not planning. It reads snapshots, never the platform, and it writes only
   * insights — it cannot touch strategy_versions, which is what keeps Phase 5
   * at "measured" rather than "learned".
   */
  async analyzePerformance(accountId: string): Promise<AnalyticsAnalysisOutcome> {
    const { agentRunRepository, contextLoader, toolRouter, llm, logger } = this.deps;

    if (!this.analyticsAgent || !this.analyticsDeps) {
      throw new Error("AnalyticsAgent is not configured on this orchestrator");
    }

    const run = await agentRunRepository.create(accountId);
    await agentRunRepository.markRunning(run.id);
    logger.info({ runId: run.id, accountId }, "analytics_run.started");

    try {
      const contextData = await contextLoader.load(accountId);
      const analyticsInput = await buildAnalyticsAgentInput({
        analyticsService: this.analyticsDeps.analyticsService,
        analyticsRepository: this.analyticsDeps.analyticsRepository,
        socialAccountRepository: this.analyticsDeps.socialAccountRepository,
        agentProfileRepository: this.analyticsDeps.agentProfileRepository,
        socialAccountId: accountId,
      });

      const result = await this.analyticsAgent.run({
        ...contextData,
        analyticsInput,
        runId: run.id,
        accountId,
        logger,
        llm,
        tools: toolRouter,
        previousResults: {},
        targetContentIdea: null,
        regenerationFeedback: [],
      });

      // Decisions land in the existing audit trail; insights are additionally
      // persisted as queryable rows for the dashboard and later phases.
      await this.persistGenericResult(run.id, "analytics", result);

      const insights = (result.data as { insights?: AnalyticsInsightResult } | undefined)?.insights;
      if (insights && insights.observations.length > 0) {
        await this.analyticsDeps.analyticsRepository.saveInsights(
          insights.observations.map((observation) => ({
            socialAccountId: accountId,
            agentRunId: run.id,
            insightType: observation.type,
            dimension: observation.dimension,
            dimensionValue: observation.dimensionValue,
            finding: observation.finding,
            evidence: { evidence: observation.evidence, summary: insights.summary, dataQuality: insights.dataQuality },
            confidence: observation.confidence,
            sampleSize: observation.sampleSize,
          })),
        );
      }

      await agentRunRepository.markFinished(run.id, "completed");
      logger.info(
        { runId: run.id, accountId, observations: insights?.observations.length ?? 0, postCount: analyticsInput.postCount },
        "analytics_run.completed",
      );

      return { runId: run.id, status: "completed", postCount: analyticsInput.postCount, insights };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await agentRunRepository.markFinished(run.id, "failed", message);
      logger.error({ runId: run.id, accountId, error: message }, "analytics_run.failed");
      return { runId: run.id, status: "failed", postCount: 0, error: message };
    }
  }

  /** Records every decision/action for a stage inside `tx`, returning the last decision's id (actions link to it). */
  private async recordDecisionsAndActions(
    tx: DrizzleClient,
    runId: string,
    agentName: string,
    result: AgentResult,
  ): Promise<void> {
    const runRepo = new AgentRunRepository(tx);
    let lastDecisionId: string | undefined;
    for (const decision of result.decisions) {
      const row = await runRepo.recordDecision({
        agentRunId: runId,
        agentName,
        decision: decision.decision,
        reason: decision.reason,
        metadata: decision.metadata,
      });
      lastDecisionId = row.id;
      this.deps.logger.info(
        { runId, agentName, decision: decision.decision, reason: decision.reason },
        "agent_run.decision",
      );
    }
    for (const action of result.actions) {
      await runRepo.recordAction({
        agentRunId: runId,
        agentDecisionId: lastDecisionId,
        actionType: action.actionType,
        status: action.status,
        payload: action.payload,
        result: action.result,
      });
    }
  }

  /** Fallback for any agent without a dedicated persistence step (e.g. future skeleton agents). */
  private async persistGenericResult(runId: string, agentName: string, result: AgentResult): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await this.recordDecisionsAndActions(tx, runId, agentName, result);
    });
  }

  private async persistResearchResult(runId: string, accountId: string, result: AgentResult): Promise<void> {
    const topics = (result.data as { topics?: ResearchResult["topics"] } | undefined)?.topics ?? [];

    await this.deps.db.transaction(async (tx) => {
      await this.recordDecisionsAndActions(tx, runId, "research", result);

      const researchRepo = new ResearchRepository(tx);
      const existing = await researchRepo.listByRunId(runId);
      if (existing.length === 0 && topics.length > 0) {
        await researchRepo.createMany(
          topics.map((t) => ({
            socialAccountId: accountId,
            agentRunId: runId,
            topic: t.topic,
            relevanceScore: t.relevanceScore,
            audienceInterestScore: t.audienceInterestScore,
            competitionScore: t.competitionScore,
            rationale: t.rationale,
            sourceType: "mock",
          })),
        );
      }
    });
  }

  /** Returns the strategy version id now current for this profile (new or unchanged), for ContentPlanner traceability. */
  private async persistStrategyResult(
    runId: string,
    contextData: AgentContextData,
    result: AgentResult,
  ): Promise<string | undefined> {
    const data = result.data as (StrategyResult & { shouldUpdateStrategy: boolean }) | undefined;

    return this.deps.db.transaction(async (tx) => {
      await this.recordDecisionsAndActions(tx, runId, "strategy", result);

      if (!data?.shouldUpdateStrategy) {
        return contextData.currentStrategy?.versionId;
      }

      const strategyRepo = new StrategyRepository(tx);

      const existingVersion = await strategyRepo.findVersionByRunId(runId);
      if (existingVersion) return existingVersion.id;

      let strategy = (await strategyRepo.findByAgentProfileId(contextData.agentProfileId))[0];
      if (!strategy) {
        strategy = await strategyRepo.create({
          agentProfileId: contextData.agentProfileId,
          name: `${contextData.account.niche} strategy`,
        });
      }

      const latest = await strategyRepo.latestVersion(strategy.id);
      const nextVersionNumber = (latest?.versionNumber ?? 0) + 1;

      const version = await strategyRepo.createVersion({
        strategyId: strategy.id,
        versionNumber: nextVersionNumber,
        summary: data.reasoningSummary,
        content: {
          audience: data.audience,
          positioning: data.positioning,
          contentPillars: data.contentPillars,
          formats: data.formats,
          postingFrequencyPerWeek: data.postingFrequencyPerWeek,
        },
        createdBy: "strategy_agent",
        agentRunId: runId,
      });
      return version.id;
    });
  }

  private async persistContentPlanResult(
    runId: string,
    agentProfileId: string,
    result: AgentResult,
    strategyVersionId: string | undefined,
  ): Promise<void> {
    const ideas = (result.data as { ideas?: ContentPlanResult["ideas"] } | undefined)?.ideas ?? [];

    await this.deps.db.transaction(async (tx) => {
      await this.recordDecisionsAndActions(tx, runId, "content_planner", result);

      const contentRepo = new ContentRepository(tx);
      const existing = await contentRepo.listIdeasByRunId(runId);
      if (existing.length === 0 && ideas.length > 0) {
        await contentRepo.createIdeas(
          ideas.map((idea) => ({
            agentProfileId,
            agentRunId: runId,
            strategyVersionId,
            title: idea.title,
            description: idea.hook,
            format: idea.format,
            contentPillar: idea.contentPillar,
            targetAudience: idea.targetAudience,
            hook: idea.hook,
            objective: idea.objective,
            priorityScore: idea.priorityScore,
          })),
        );
      }
    });
  }

  /** Persists one generation attempt's decision/action + the versioned content_generations row. Idempotent per (postId, version). */
  private async persistGenerationAttempt(
    runId: string,
    contentPostId: string,
    attempt: number,
    creatorResult: AgentResult,
    generatedContent: GeneratedContent,
  ) {
    return this.deps.db.transaction(async (tx) => {
      await this.recordDecisionsAndActions(tx, runId, "content_creator", creatorResult);

      const generationRepo = new ContentGenerationRepository(tx);
      const existing = await generationRepo.findByPostIdAndVersion(contentPostId, attempt);
      if (existing) return existing;

      return generationRepo.createGeneration({
        contentPostId,
        versionNumber: attempt,
        attemptNumber: attempt,
        format: generatedContent.format,
        payload: generatedContent,
        status: "generated",
        agentRunId: runId,
        llmProvider: this.deps.llm.name,
      });
    });
  }

  /** Calls the generateImage tool (policy-gated) for non-text formats and records the resulting asset. Failures don't fail the whole attempt — reviewer still evaluates the copy. */
  private async generateAndPersistCoverImage(
    accountId: string,
    contentPostId: string,
    contentGenerationId: string,
    generatedContent: GeneratedContent,
  ): Promise<void> {
    const visualDirection =
      "visualDirection" in generatedContent && generatedContent.visualDirection
        ? generatedContent.visualDirection
        : generatedContent.hook;

    const generationRepo = new ContentGenerationRepository(this.deps.db);
    const assetRow = await generationRepo.createAsset({
      contentGenerationId,
      assetType: "image",
      provider: this.deps.imageGeneratorName,
      status: "requested",
    });

    // A media provider being down/unreachable must never fail the whole
    // attempt: the copy is already generated and the Reviewer can still
    // evaluate it. The asset row records the failure instead, so it stays
    // visible and retryable rather than silently lost.
    let result: ToolResult<{
      storageKey: string;
      url: string;
      mimeType: string;
      provider: string;
      storageProvider: string;
      sizeBytes: number;
      providerAssetId?: string;
      width?: number;
      height?: number;
      converted: boolean;
      originalMimeType: string;
    }>;
    try {
      result = await this.deps.toolRouter.call("generateImage", accountId, {
        prompt: visualDirection,
        accountId,
        contentId: contentPostId,
        // The asset row already exists, so its id is what names the object —
        // the database row and the stored object share one identity.
        assetId: assetRow.id,
      });
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (!result.success || !result.data) {
      await generationRepo.updateAssetStatus(assetRow.id, { status: "failed", errorMessage: result.error ?? "Unknown image generation error" });
      this.deps.logger.warn({ contentGenerationId, error: result.error }, "content_generation.media_failed");
      return;
    }

    await generationRepo.updateAssetStatus(assetRow.id, {
      status: "completed",
      provider: result.data.provider,
      storageKey: result.data.storageKey,
      url: result.data.url,
      mimeType: result.data.mimeType,
      providerAssetId: result.data.providerAssetId,
      width: result.data.width,
      height: result.data.height,
      storageProvider: result.data.storageProvider,
      sizeBytes: result.data.sizeBytes,
    });

    this.deps.logger.info(
      {
        assetId: assetRow.id,
        contentId: contentPostId,
        objectKey: result.data.storageKey,
        storageProvider: result.data.storageProvider,
        size: result.data.sizeBytes,
        mimeType: result.data.mimeType,
        converted: result.data.converted,
        originalMimeType: result.data.originalMimeType,
      },
      "content_generation.media_stored",
    );
  }

  private async persistReviewResult(runId: string, contentGenerationId: string, reviewerResult: AgentResult, review: ReviewResult) {
    await this.deps.db.transaction(async (tx) => {
      await this.recordDecisionsAndActions(tx, runId, "reviewer", reviewerResult);

      const generationRepo = new ContentGenerationRepository(tx);
      const existing = await generationRepo.findReviewByGenerationId(contentGenerationId);
      if (existing) return;

      await generationRepo.createReview({
        contentGenerationId,
        approved: review.approved,
        score: review.score,
        qualityScore: review.qualityScore,
        brandScore: review.brandScore,
        safetyScore: review.safetyScore,
        issues: review.issues,
        warnings: review.warnings,
        recommendedChanges: review.recommendedChanges,
        agentRunId: runId,
      });
    });
  }
}
