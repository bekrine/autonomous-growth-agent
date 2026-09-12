import type {
  AgentProfileRepository,
  AgentRunRepository,
  ContentGenerationRepository,
  ContentRepository,
  ResearchRepository,
  StrategyRepository,
} from "@agent/database";
import { NotFoundError } from "@agent/shared";
import type { AgentOrchestrator } from "./orchestrator.js";

export interface AgentRunServiceDeps {
  orchestrator: AgentOrchestrator;
  agentRunRepository: AgentRunRepository;
  researchRepository: ResearchRepository;
  strategyRepository: StrategyRepository;
  contentRepository: ContentRepository;
  contentGenerationRepository: ContentGenerationRepository;
  agentProfileRepository: AgentProfileRepository;
}

/**
 * The application service between a caller (Express controller, or the
 * BullMQ agent-run job processor) and the orchestrator:
 *   Controller/Worker -> AgentRunService -> AgentOrchestrator
 * Framework-agnostic on purpose — both apps/api and workers/agent-worker
 * import this exact class (via buildAgentSystem) so "run an agent run" (or
 * "generate content for an idea") has one implementation regardless of
 * which path triggered it. Owns nothing the orchestrator doesn't already
 * persist — it only re-reads the persisted rows to shape a structured result.
 */
export class AgentRunService {
  constructor(private readonly deps: AgentRunServiceDeps) {}

  /**
   * Interprets already-collected analytics. Kept here so the API route and any
   * future scheduled job share one implementation — the same rule as startRun.
   * This never collects: collection is the worker's job and is deterministic.
   */
  async analyzePerformance(accountId: string) {
    return this.deps.orchestrator.analyzePerformance(accountId);
  }

  async startRun(accountId: string) {
    const outcome = await this.deps.orchestrator.executeRun(accountId);
    const response = await this.buildRunResponse(outcome.runId, outcome.status, accountId);
    return { ...response, error: outcome.error };
  }

  /** Resumes/retries an existing run — used by the BullMQ job processor for redelivered jobs. */
  async resumeRun(accountId: string, runId: string) {
    const outcome = await this.deps.orchestrator.executeRun(accountId, { runId });
    const response = await this.buildRunResponse(outcome.runId, outcome.status, accountId);
    return { ...response, error: outcome.error };
  }

  async listRuns() {
    return this.deps.agentRunRepository.listRecent();
  }

  async getRun(runId: string) {
    const run = await this.deps.agentRunRepository.findById(runId);
    if (!run) throw new NotFoundError("AgentRun", runId);

    const [response, decisions, actions] = await Promise.all([
      this.buildRunResponse(runId, run.status, run.socialAccountId),
      this.deps.agentRunRepository.listDecisions(runId),
      this.deps.agentRunRepository.listActions(runId),
    ]);

    return { ...response, decisions, actions };
  }

  /** Runs ContentCreator -> media generation -> Reviewer (looped up to the configured max) for one content idea. */
  async generateContent(accountId: string, contentIdeaId: string) {
    const outcome = await this.deps.orchestrator.generateContent(accountId, contentIdeaId);
    return this.buildContentResponse(outcome.contentPostId, outcome.error);
  }

  /** Resumes/retries a content-generation run for a redelivered queue job. */
  async resumeContentGeneration(accountId: string, contentIdeaId: string, runId: string) {
    const outcome = await this.deps.orchestrator.generateContent(accountId, contentIdeaId, { runId });
    return this.buildContentResponse(outcome.contentPostId, outcome.error);
  }

  /** Current state of a content post: latest generation, its review, and its assets. */
  async getContent(contentPostId: string) {
    return this.buildContentResponse(contentPostId);
  }

  /** Full version history for a content post — every generation attempt and its review, oldest first. */
  async getContentVersions(contentPostId: string) {
    const post = await this.deps.contentRepository.findPostById(contentPostId);
    if (!post) throw new NotFoundError("ContentPost", contentPostId);

    const generations = await this.deps.contentGenerationRepository.listByPostId(contentPostId);
    const versions = await Promise.all(
      generations.map(async (generation) => {
        const [review, assets] = await Promise.all([
          this.deps.contentGenerationRepository.findReviewByGenerationId(generation.id),
          this.deps.contentGenerationRepository.listAssetsByGenerationId(generation.id),
        ]);
        return this.toGenerationSnapshot(generation, review, assets);
      }),
    );

    return { contentPostId, status: post.status, versions };
  }

  /** Manually re-runs review evaluation logic is not exposed here — review only happens as part of generation. Kept for API symmetry: returns the current (already-recorded) review for the latest version. */
  async getLatestReview(contentPostId: string) {
    const latest = await this.deps.contentGenerationRepository.findLatestByPostId(contentPostId);
    if (!latest) return null;
    return this.deps.contentGenerationRepository.findReviewByGenerationId(latest.id);
  }

  private async buildContentResponse(contentPostId: string, error?: string) {
    const post = await this.deps.contentRepository.findPostById(contentPostId);
    if (!post) throw new NotFoundError("ContentPost", contentPostId);

    const latestGeneration = await this.deps.contentGenerationRepository.findLatestByPostId(contentPostId);
    const [review, assets] = latestGeneration
      ? await Promise.all([
          this.deps.contentGenerationRepository.findReviewByGenerationId(latestGeneration.id),
          this.deps.contentGenerationRepository.listAssetsByGenerationId(latestGeneration.id),
        ])
      : [null, []];

    return {
      contentId: post.id,
      status: post.status,
      generationVersion: post.currentGenerationVersion,
      generationAttempts: post.generationAttempts,
      generation: latestGeneration ? this.toGenerationSnapshot(latestGeneration, review, assets) : null,
      error,
    };
  }

  private toGenerationSnapshot(
    generation: {
      id: string;
      versionNumber: number;
      attemptNumber: number;
      format: string;
      payload: unknown;
      status: string;
      errorMessage: string | null;
      createdAt: Date;
    },
    review: {
      approved: boolean;
      score: string;
      qualityScore: string;
      brandScore: string;
      safetyScore: string;
      issues: unknown;
      warnings: unknown;
      recommendedChanges: unknown;
    } | null,
    assets: {
      id: string;
      assetType: string;
      url: string | null;
      provider: string;
      status: string;
      mimeType: string | null;
      storageProvider: string | null;
      sizeBytes: number | null;
      width: number | null;
      height: number | null;
    }[],
  ) {
    const payload = (generation.payload ?? {}) as Record<string, unknown>;
    return {
      generationId: generation.id,
      version: generation.versionNumber,
      attempt: generation.attemptNumber,
      format: generation.format,
      status: generation.status,
      errorMessage: generation.errorMessage,
      hook: payload.hook as string | undefined,
      title: payload.title as string | undefined,
      caption: payload.caption as string | undefined,
      callToAction: payload.callToAction as string | undefined,
      altText: payload.altText as string | undefined,
      visualDirection: (payload as { visualDirection?: string }).visualDirection,
      headline: (payload as { headline?: string }).headline,
      supportingText: (payload as { supportingText?: string }).supportingText,
      script: (payload as { script?: unknown }).script,
      slides: (payload as { slides?: unknown }).slides,
      body: (payload as { body?: string }).body,
      keywords: payload.keywords as string[] | undefined,
      contentWarnings: payload.contentWarnings as string[] | undefined,
      // Public-facing asset shape. `publicUrl` is the only storage detail the
      // browser needs; bucket names, keys and credentials never appear here.
      assets: assets.map((a) => ({
        id: a.id,
        type: a.assetType,
        assetType: a.assetType,
        url: a.url,
        publicUrl: a.url,
        mimeType: a.mimeType,
        provider: a.provider,
        storageProvider: a.storageProvider,
        sizeBytes: a.sizeBytes,
        width: a.width,
        height: a.height,
        status: a.status,
      })),
      review: review
        ? {
            approved: review.approved,
            score: Number(review.score),
            qualityScore: Number(review.qualityScore),
            brandScore: Number(review.brandScore),
            safetyScore: Number(review.safetyScore),
            issues: review.issues,
            warnings: review.warnings,
            recommendedChanges: review.recommendedChanges,
          }
        : null,
      createdAt: generation.createdAt.toISOString(),
    };
  }

  private async buildRunResponse(runId: string, status: string, accountId: string) {
    const [research, ideas, versionForRun] = await Promise.all([
      this.deps.researchRepository.listByRunId(runId),
      this.deps.contentRepository.listIdeasByRunId(runId),
      this.deps.strategyRepository.findVersionByRunId(runId),
    ]);

    const strategy = versionForRun
      ? this.toStrategySnapshot(versionForRun)
      : await this.currentStrategySnapshot(accountId);

    return {
      runId,
      status,
      research: research.map((r) => ({
        topic: r.topic,
        relevanceScore: Number(r.relevanceScore),
        audienceInterestScore: Number(r.audienceInterestScore),
        competitionScore: Number(r.competitionScore),
        rationale: r.rationale,
        sourceType: r.sourceType,
      })),
      strategy,
      contentIdeas: ideas.map((i) => ({
        id: i.id,
        title: i.title,
        format: i.format,
        contentPillar: i.contentPillar,
        targetAudience: i.targetAudience,
        hook: i.hook,
        objective: i.objective,
        priorityScore: i.priorityScore ? Number(i.priorityScore) : null,
      })),
    };
  }

  private toStrategySnapshot(version: { versionNumber: number; summary: string; content: unknown; createdAt: Date }) {
    return {
      versionNumber: version.versionNumber,
      summary: version.summary,
      data: version.content,
      createdAt: version.createdAt.toISOString(),
    };
  }

  private async currentStrategySnapshot(accountId: string) {
    const profile = await this.deps.agentProfileRepository.findBySocialAccountId(accountId);
    if (!profile) return null;
    const [strategy] = await this.deps.strategyRepository.findByAgentProfileId(profile.id);
    if (!strategy) return null;
    const latest = await this.deps.strategyRepository.latestVersion(strategy.id);
    return latest ? this.toStrategySnapshot(latest) : null;
  }
}
