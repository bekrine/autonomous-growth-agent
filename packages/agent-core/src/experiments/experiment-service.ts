import type {
  AgentProfileRepository,
  ContentRepository,
  ExperimentRepository,
  OutboxRepository,
} from "@agent/database";
import { NotFoundError, ValidationError, type Logger } from "@agent/shared";
import type { AnalyticsService } from "../analytics/analytics-service.js";
import type { PublishingService } from "../publishing/publishing-service.js";
import {
  DEFAULT_EXPERIMENT_LIMITS,
  type ExperimentLimits,
} from "./experiment-config.js";
import {
  ExperimentValidationService,
  type ExperimentDraft,
  type ValidationResult,
} from "./experiment-validation.js";
import { ExperimentEvaluationService, type EvaluationResult, type VariantSample } from "./experiment-evaluation.js";
import { buildBalancedQueue } from "./variant-assignment.js";

/**
 * Owns the experiment lifecycle, and only that.
 *
 * It does not generate content, publish, or compute metrics — those belong to
 * Phase 3, 4 and 5 respectively, and this service calls into them. That
 * boundary is what stops Phase 6 from becoming a second, divergent copy of the
 * pipeline.
 *
 * It also does not change strategy. An experiment produces a result and a
 * recommendation; acting on it is Phase 7's job.
 */

export interface ExperimentServiceDeps {
  experimentRepository: ExperimentRepository;
  contentRepository: ContentRepository;
  agentProfileRepository: AgentProfileRepository;
  outboxRepository: OutboxRepository;
  analyticsService: AnalyticsService;
  publishingService: PublishingService;
  logger: Logger;
  limits?: Partial<ExperimentLimits>;
}

export interface CreateExperimentResult {
  created: boolean;
  experimentId?: string;
  validation: ValidationResult;
}

export class ExperimentService {
  private readonly validator: ExperimentValidationService;
  private readonly evaluator = new ExperimentEvaluationService();

  constructor(private readonly deps: ExperimentServiceDeps) {
    this.validator = new ExperimentValidationService(this.limits);
  }

  private get limits(): ExperimentLimits {
    return { ...DEFAULT_EXPERIMENT_LIMITS, ...this.deps.limits };
  }

  /**
   * Validates a draft and persists it as `draft`. Validation runs against the
   * account's *current* state, so the concurrency rule is enforced at creation
   * rather than discovered at start time.
   */
  async createExperiment(
    socialAccountId: string,
    draft: ExperimentDraft,
    options: { proposedByAgentRunId?: string; allowMultiFactor?: boolean } = {},
  ): Promise<CreateExperimentResult> {
    const profile = await this.deps.agentProfileRepository.findBySocialAccountId(socialAccountId);
    if (!profile) throw new NotFoundError("AgentProfile", socialAccountId);

    const active = await this.deps.experimentRepository.listActiveForAccount(socialAccountId);
    const validation = this.validator.validate(draft, {
      activeVariables: active.map((e) => e.variable).filter((v): v is string => Boolean(v)),
      activeExperimentCount: active.length,
      limits: this.deps.limits,
      allowMultiFactor: options.allowMultiFactor,
    });

    if (!validation.valid || !validation.normalized) {
      this.deps.logger.warn(
        { socialAccountId, errors: validation.errors.map((e) => e.code) },
        "experiment.validation_failed",
      );
      return { created: false, validation };
    }

    const normalized = validation.normalized;
    const experiment = await this.deps.experimentRepository.createExperiment({
      agentProfileId: profile.id,
      socialAccountId,
      name: normalized.name,
      hypothesis: normalized.hypothesis,
      variable: normalized.variable,
      primaryMetric: normalized.primaryMetric,
      secondaryMetrics: normalized.secondaryMetrics,
      minSamplesPerVariant: normalized.minSamplesPerVariant,
      observationWindowHours: normalized.observationWindowHours,
      maxDurationDays: normalized.maxDurationDays,
      minRelativeLift: normalized.minRelativeLift,
      proposedByAgentRunId: options.proposedByAgentRunId ?? null,
      status: "draft",
    });

    for (const variant of normalized.variants) {
      await this.deps.experimentRepository.createVariant({
        experimentId: experiment.id,
        name: variant.name,
        role: variant.role,
        variableValue: variant.variableValue,
        description: variant.description,
        targetSampleSize: normalized.minSamplesPerVariant,
      });
    }

    this.deps.logger.info(
      {
        experimentId: experiment.id,
        socialAccountId,
        variable: normalized.variable,
        primaryMetric: normalized.primaryMetric,
        variants: normalized.variants.length,
        warnings: validation.warnings.map((w) => w.code),
      },
      "experiment.created",
    );

    return { created: true, experimentId: experiment.id, validation };
  }

  /** Draft → ready. A separate step so a human can review the design first. */
  async markReady(experimentId: string) {
    const row = await this.deps.experimentRepository.transitionStatus(experimentId, "ready", { from: ["draft"] });
    if (!row) throw new ValidationError("Only a draft experiment can be marked ready.");
    return row;
  }

  /**
   * Starts an experiment. Re-checks concurrency at this moment, because the
   * account's state may have changed since the draft was created.
   */
  async start(experimentId: string) {
    const experiment = await this.requireExperiment(experimentId);

    const active = await this.deps.experimentRepository.listActiveForAccount(experiment.socialAccountId!);
    const conflicting = active.filter((e) => e.id !== experimentId && e.variable === experiment.variable);
    if (conflicting.length > 0) {
      throw new ValidationError(
        `Another running experiment is already varying "${experiment.variable}" for this account.`,
      );
    }

    const row = await this.deps.experimentRepository.transitionStatus(experimentId, "running", {
      from: ["draft", "ready", "paused"],
      startedAt: experiment.startedAt ?? new Date(),
      reason: null,
    });
    if (!row) throw new ValidationError("Only a draft, ready or paused experiment can be started.");

    this.deps.logger.info({ experimentId, variable: experiment.variable }, "experiment.started");
    return row;
  }

  async pause(experimentId: string, reason?: string) {
    const row = await this.deps.experimentRepository.transitionStatus(experimentId, "paused", {
      from: ["running"],
      reason: reason ?? null,
    });
    if (!row) throw new ValidationError("Only a running experiment can be paused.");
    return row;
  }

  /**
   * Cancels an experiment and every arm, so nothing further publishes under it.
   * Already-published posts and past evaluations are left untouched — history
   * stays auditable.
   */
  async cancel(experimentId: string, reason?: string) {
    const row = await this.deps.experimentRepository.transitionStatus(experimentId, "cancelled", {
      from: ["draft", "ready", "running", "paused", "analyzing"],
      reason: reason ?? null,
      endedAt: new Date(),
    });
    if (!row) throw new ValidationError("This experiment cannot be cancelled from its current state.");

    for (const variant of await this.deps.experimentRepository.listVariants(experimentId)) {
      await this.deps.experimentRepository.setVariantStatus(variant.id, "cancelled");
    }

    this.deps.logger.info({ experimentId, reason }, "experiment.cancelled");
    return row;
  }

  /**
   * Assigns a content post to an arm and links it for analytics grouping.
   * Refuses cancelled experiments and arms — a cancelled variant must never
   * acquire new content.
   */
  async attachContent(experimentId: string, variantId: string, contentPostId: string) {
    const experiment = await this.requireExperiment(experimentId);
    if (["cancelled", "completed", "inconclusive", "failed"].includes(experiment.status)) {
      throw new ValidationError(`Experiment is ${experiment.status}; no further content may be attached.`);
    }

    const variant = await this.deps.experimentRepository.findVariantById(variantId);
    if (!variant || variant.experimentId !== experimentId) throw new NotFoundError("ExperimentVariant", variantId);
    if (variant.status !== "active") throw new ValidationError(`Variant "${variant.name}" is cancelled.`);

    const perDay = await this.deps.experimentRepository.countExperimentPostsSince(
      experimentId,
      new Date(Date.now() - 24 * 60 * 60_000),
    );
    if (perDay >= this.limits.maxExperimentContentPerDay) {
      throw new ValidationError(
        `This experiment already created ${perDay} posts in the last 24h (limit ${this.limits.maxExperimentContentPerDay}).`,
      );
    }

    const row = await this.deps.experimentRepository.attachPostToVariant(contentPostId, experimentId, variantId);
    if (!row) throw new NotFoundError("ContentPost", contentPostId);

    this.deps.logger.info({ experimentId, variantId, contentPostId }, "experiment.content_attached");
    return row;
  }

  /**
   * The publishing order for outstanding slots, interleaved so neither arm
   * clusters at one time of day. Callers publish through PublishingService —
   * this only decides which arm is next.
   */
  async planSchedule(experimentId: string) {
    const experiment = await this.requireExperiment(experimentId);
    const variants = await this.deps.experimentRepository.listVariants(experimentId);
    const posts = await this.deps.experimentRepository.listExperimentPosts(experimentId);

    const publishedPerVariant: Record<string, number> = {};
    for (const post of posts) {
      if (!post.experimentVariantId) continue;
      publishedPerVariant[post.experimentVariantId] = (publishedPerVariant[post.experimentVariantId] ?? 0) + 1;
    }

    return buildBalancedQueue(
      variants.map((v) => ({
        id: v.id,
        name: v.name,
        role: (v.role as "control" | "variant") ?? "variant",
        status: v.status,
      })),
      publishedPerVariant,
      experiment.minSamplesPerVariant ?? this.limits.minSamplesPerVariant,
    );
  }

  /** Live progress per arm — how many posts exist, and how many are published. */
  async getProgress(experimentId: string) {
    const experiment = await this.requireExperiment(experimentId);
    const variants = await this.deps.experimentRepository.listVariants(experimentId);
    const posts = await this.deps.experimentRepository.listExperimentPosts(experimentId);
    const target = experiment.minSamplesPerVariant ?? this.limits.minSamplesPerVariant;

    const byVariant = variants.map((variant) => {
      const own = posts.filter((p) => p.experimentVariantId === variant.id);
      return {
        variantId: variant.id,
        name: variant.name,
        role: variant.role,
        variableValue: variant.variableValue,
        status: variant.status,
        assigned: own.length,
        published: own.filter((p) => p.status === "published").length,
        target,
      };
    });

    return {
      experimentId,
      status: experiment.status,
      target,
      variants: byVariant,
      totalPublished: byVariant.reduce((sum, v) => sum + v.published, 0),
      readyToEvaluate: byVariant.every((v) => v.published >= target),
    };
  }

  /**
   * Groups measured metrics by arm and runs the deterministic comparison.
   *
   * Metrics come from Phase 5 — this never calls a platform and never computes
   * a metric of its own. Results are appended, never overwritten.
   */
  async evaluate(experimentId: string): Promise<{ evaluation: EvaluationResult; created: boolean }> {
    const experiment = await this.requireExperiment(experimentId);
    if (!experiment.primaryMetric) throw new ValidationError("Experiment has no primary metric configured.");

    await this.deps.experimentRepository.transitionStatus(experimentId, "analyzing", { from: ["running"] });

    const variants = await this.deps.experimentRepository.listVariants(experimentId);
    const posts = await this.deps.experimentRepository.listExperimentPosts(experimentId);
    const performance = await this.deps.analyticsService.getPostPerformance(experiment.socialAccountId!, 200);

    const metricByPost = new Map<string, number | undefined>();
    for (const entry of performance) {
      if (!entry.snapshot.contentPostId) continue;
      const metric = entry.metrics.find((m) => m.name === experiment.primaryMetric);
      metricByPost.set(entry.snapshot.contentPostId, metric?.available ? metric.value : undefined);
    }

    const samples: VariantSample[] = variants.map((variant) => {
      // Only published posts count: an unpublished post has no performance.
      const own = posts.filter((p) => p.experimentVariantId === variant.id && p.status === "published");
      return {
        variantId: variant.id,
        name: variant.name,
        role: (variant.role as "control" | "variant") ?? "variant",
        variableValue: variant.variableValue,
        contentPostIds: own.map((p) => p.id),
        values: own.map((p) => metricByPost.get(p.id)),
      };
    });

    const observationWindowMs = (experiment.observationWindowHours ?? this.limits.observationWindowHours) * 3_600_000;

    const result = this.evaluator.evaluate({
      primaryMetric: experiment.primaryMetric,
      samples,
      limits: {
        minSamplesPerVariant: experiment.minSamplesPerVariant ?? this.limits.minSamplesPerVariant,
        minRelativeLift: Number(experiment.minRelativeLift ?? this.limits.minRelativeLift),
        maxSampleImbalanceRatio: this.limits.maxSampleImbalanceRatio,
      },
    });

    const { evaluation, created } = await this.deps.experimentRepository.recordEvaluationIfAbsent({
      experimentId,
      evaluationKey: result.evaluationKey,
      outcome: result.outcome,
      primaryMetric: result.primaryMetric,
      controlValue: result.controlValue,
      variantValue: result.variantValue,
      relativeLift: result.relativeLift,
      confidence: result.confidence,
      sampleSizes: result.sampleSizes,
      detail: {
        summaries: result.summaries,
        thresholds: result.thresholds,
        reasons: result.reasons,
        winner: result.winner,
        winningVariantId: result.winningVariantId,
        observationWindowMs,
      },
      conclusion: result.conclusion,
    });

    // A terminal verdict ends the experiment; anything else leaves it running
    // so more samples can accumulate.
    const terminal = result.outcome === "variant_winner" || result.outcome === "control_winner";
    const settled = terminal || result.outcome === "no_clear_winner";

    await this.deps.experimentRepository.transitionStatus(
      experimentId,
      settled ? (terminal ? "completed" : "inconclusive") : "running",
      settled ? { endedAt: new Date() } : {},
    );

    this.deps.logger.info(
      {
        experimentId,
        outcome: result.outcome,
        confidence: result.confidence,
        primaryMetric: result.primaryMetric,
        sampleSizes: result.sampleSizes,
        created,
      },
      "experiment.evaluated",
    );

    return { evaluation: result, created };
  }

  async getExperiment(experimentId: string) {
    const experiment = await this.requireExperiment(experimentId);
    const [variants, evaluations, posts] = await Promise.all([
      this.deps.experimentRepository.listVariants(experimentId),
      this.deps.experimentRepository.listEvaluations(experimentId),
      this.deps.experimentRepository.listExperimentPosts(experimentId),
    ]);
    return { experiment, variants, evaluations, posts };
  }

  async listForAccount(socialAccountId: string) {
    return this.deps.experimentRepository.listByAccount(socialAccountId);
  }

  private async requireExperiment(experimentId: string) {
    const experiment = await this.deps.experimentRepository.findById(experimentId);
    if (!experiment) throw new NotFoundError("Experiment", experimentId);
    return experiment;
  }
}
