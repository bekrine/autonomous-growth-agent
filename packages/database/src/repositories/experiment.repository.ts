import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import {
  agentProfiles,
  contentPosts,
  experimentEvaluations,
  experimentVariants,
  experiments,
} from "../schema/index.js";
import { socialAccounts } from "../schema/core.js";

/** Statuses that mean an experiment is occupying a variable right now. */
export const ACTIVE_EXPERIMENT_STATUSES = ["ready", "running", "analyzing"] as const;

export interface CreateExperimentInput {
  agentProfileId: string;
  socialAccountId: string;
  name: string;
  hypothesis: string;
  variable: string;
  primaryMetric: string;
  secondaryMetrics?: string[];
  minSamplesPerVariant: number;
  observationWindowHours: number;
  maxDurationDays: number;
  minRelativeLift: number;
  proposedByAgentRunId?: string | null;
  status?: "draft" | "ready";
}

export interface CreateVariantInput {
  experimentId: string;
  name: string;
  role: "control" | "variant";
  variableValue: string;
  description?: string;
  targetSampleSize?: number;
}

export class ExperimentRepository {
  constructor(private readonly db: DrizzleClient) {}

  async listForAccount(socialAccountId: string) {
    return this.db
      .select({ experiment: experiments })
      .from(experiments)
      .innerJoin(agentProfiles, eq(experiments.agentProfileId, agentProfiles.id))
      .innerJoin(socialAccounts, eq(agentProfiles.socialAccountId, socialAccounts.id))
      .where(eq(socialAccounts.id, socialAccountId))
      .orderBy(desc(experiments.createdAt));
  }

  /** Phase 1 signature, retained so existing callers keep working. */
  async create(input: { agentProfileId: string; name: string; hypothesis?: string }) {
    const [row] = await this.db.insert(experiments).values(input).returning();
    return row;
  }

  async createExperiment(input: CreateExperimentInput) {
    const [row] = await this.db
      .insert(experiments)
      .values({
        agentProfileId: input.agentProfileId,
        socialAccountId: input.socialAccountId,
        name: input.name,
        hypothesis: input.hypothesis,
        variable: input.variable,
        primaryMetric: input.primaryMetric,
        secondaryMetrics: input.secondaryMetrics ?? [],
        minSamplesPerVariant: input.minSamplesPerVariant,
        observationWindowHours: input.observationWindowHours,
        maxDurationDays: input.maxDurationDays,
        minRelativeLift: String(input.minRelativeLift),
        proposedByAgentRunId: input.proposedByAgentRunId ?? null,
        status: input.status ?? "draft",
      })
      .returning();
    return row!;
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(experiments).where(eq(experiments.id, id));
    return row ?? null;
  }

  async listByAccount(socialAccountId: string) {
    return this.db
      .select()
      .from(experiments)
      .where(eq(experiments.socialAccountId, socialAccountId))
      .orderBy(desc(experiments.createdAt));
  }

  /** Experiments currently occupying a variable — the concurrency guard's input. */
  async listActiveForAccount(socialAccountId: string) {
    return this.db
      .select()
      .from(experiments)
      .where(
        and(
          eq(experiments.socialAccountId, socialAccountId),
          inArray(experiments.status, [...ACTIVE_EXPERIMENT_STATUSES]),
        ),
      );
  }

  /**
   * Conditional status transition. Returning no row means the experiment was
   * not in an expected state — a concurrent transition won, and the caller
   * must not proceed as though it had.
   */
  async transitionStatus(
    id: string,
    to: "draft" | "ready" | "running" | "analyzing" | "completed" | "inconclusive" | "paused" | "cancelled" | "failed",
    options: { from?: string[]; reason?: string | null; startedAt?: Date; endedAt?: Date } = {},
  ) {
    const [row] = await this.db
      .update(experiments)
      .set({
        status: to,
        ...(options.reason !== undefined ? { statusReason: options.reason } : {}),
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
        ...(options.endedAt ? { endedAt: options.endedAt } : {}),
        updatedAt: new Date(),
      })
      .where(
        options.from && options.from.length > 0
          ? and(eq(experiments.id, id), inArray(experiments.status, options.from as never[]))
          : eq(experiments.id, id),
      )
      .returning();
    return row ?? null;
  }

  // --- variants ---

  async createVariant(input: CreateVariantInput) {
    const [row] = await this.db
      .insert(experimentVariants)
      .values({
        experimentId: input.experimentId,
        name: input.name,
        role: input.role,
        variableValue: input.variableValue,
        description: input.description ?? null,
        targetSampleSize: input.targetSampleSize ?? null,
        status: "active",
      })
      .returning();
    return row!;
  }

  async listVariants(experimentId: string) {
    return this.db
      .select()
      .from(experimentVariants)
      .where(eq(experimentVariants.experimentId, experimentId))
      .orderBy(experimentVariants.name);
  }

  async findVariantById(id: string) {
    const [row] = await this.db.select().from(experimentVariants).where(eq(experimentVariants.id, id));
    return row ?? null;
  }

  async setVariantStatus(id: string, status: "active" | "cancelled") {
    const [row] = await this.db
      .update(experimentVariants)
      .set({ status, updatedAt: new Date() })
      .where(eq(experimentVariants.id, id))
      .returning();
    return row ?? null;
  }

  // --- experiment content ---

  /**
   * Posts belonging to an experiment, via the Phase 5 columns on content_posts.
   * This is the link evaluation groups by.
   */
  async listExperimentPosts(experimentId: string) {
    return this.db
      .select({
        id: contentPosts.id,
        experimentVariantId: contentPosts.experimentVariantId,
        status: contentPosts.status,
        publishedAt: contentPosts.publishedAt,
        contentIdeaId: contentPosts.contentIdeaId,
        socialAccountId: contentPosts.socialAccountId,
      })
      .from(contentPosts)
      .where(eq(contentPosts.experimentId, experimentId))
      .orderBy(contentPosts.createdAt);
  }

  async attachPostToVariant(contentPostId: string, experimentId: string, experimentVariantId: string) {
    const [row] = await this.db
      .update(contentPosts)
      .set({ experimentId, experimentVariantId, updatedAt: new Date() })
      .where(eq(contentPosts.id, contentPostId))
      .returning();
    return row ?? null;
  }

  /** How many posts each arm has published today — feeds the per-day cost limit. */
  async countExperimentPostsSince(experimentId: string, since: Date) {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentPosts)
      // gte(), not a raw sql fragment: a raw fragment loses the column's type
      // mapping and the driver receives an unbound Date.
      .where(and(eq(contentPosts.experimentId, experimentId), gte(contentPosts.createdAt, since)));
    return rows[0]?.count ?? 0;
  }

  // --- evaluations (append-only) ---

  /**
   * Idempotent insert: the UNIQUE (experiment_id, evaluation_key) constraint
   * means re-evaluating unchanged data returns the existing row rather than
   * writing a second, identical conclusion.
   */
  async recordEvaluationIfAbsent(input: {
    experimentId: string;
    evaluationKey: string;
    outcome: string;
    primaryMetric: string;
    controlValue?: number;
    variantValue?: number;
    relativeLift?: number;
    confidence: string;
    sampleSizes: Record<string, number>;
    detail: Record<string, unknown>;
    conclusion: string;
  }): Promise<{ evaluation: typeof experimentEvaluations.$inferSelect; created: boolean }> {
    const [inserted] = await this.db
      .insert(experimentEvaluations)
      .values({
        experimentId: input.experimentId,
        evaluationKey: input.evaluationKey,
        outcome: input.outcome,
        primaryMetric: input.primaryMetric,
        controlValue: input.controlValue === undefined ? null : String(input.controlValue),
        variantValue: input.variantValue === undefined ? null : String(input.variantValue),
        relativeLift: input.relativeLift === undefined ? null : String(input.relativeLift),
        confidence: input.confidence,
        sampleSizes: input.sampleSizes,
        detail: input.detail,
        conclusion: input.conclusion,
      })
      .onConflictDoNothing({
        target: [experimentEvaluations.experimentId, experimentEvaluations.evaluationKey],
      })
      .returning();

    if (inserted) return { evaluation: inserted, created: true };

    const [existing] = await this.db
      .select()
      .from(experimentEvaluations)
      .where(
        and(
          eq(experimentEvaluations.experimentId, input.experimentId),
          eq(experimentEvaluations.evaluationKey, input.evaluationKey),
        ),
      );
    return { evaluation: existing!, created: false };
  }

  async listEvaluations(experimentId: string) {
    return this.db
      .select()
      .from(experimentEvaluations)
      .where(eq(experimentEvaluations.experimentId, experimentId))
      .orderBy(desc(experimentEvaluations.evaluatedAt));
  }

  async findLatestEvaluation(experimentId: string) {
    const [row] = await this.db
      .select()
      .from(experimentEvaluations)
      .where(eq(experimentEvaluations.experimentId, experimentId))
      .orderBy(desc(experimentEvaluations.evaluatedAt))
      .limit(1);
    return row ?? null;
  }
}
