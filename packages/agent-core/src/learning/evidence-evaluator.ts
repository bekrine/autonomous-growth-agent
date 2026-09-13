import { median } from "../analytics/derived-metrics.js";

/**
 * Deterministic evidence assessment.
 *
 * The LearningAgent is told how strong the evidence is; it does not decide.
 * A model asked "is 3 posts enough?" will happily say yes when the narrative
 * is compelling, so sufficiency is computed here and handed to it as a fact.
 *
 * The thresholds below are development heuristics, not statistical laws. They
 * are configurable, and the vocabulary is deliberately hedged ("early signal",
 * "moderate") because none of this performs a significance test.
 */

export const EVIDENCE_STRENGTHS = ["insufficient", "early_signal", "moderate", "strong"] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export interface EvidenceThresholds {
  /** Below this many eligible observations, nothing may be concluded. */
  minObservations: number;
  /** At/above this, a dimension may reach "moderate". */
  moderateObservations: number;
  /** At/above this AND with supporting experiments, a dimension may reach "strong". */
  strongObservations: number;
  /** Consistent experiments required before "strong" is available at all. */
  strongExperiments: number;
  /** Relative difference below which a dimension is "no meaningful difference". */
  minRelativeDifference: number;
}

export const DEFAULT_EVIDENCE_THRESHOLDS: EvidenceThresholds = {
  minObservations: 3,
  moderateObservations: 10,
  strongObservations: 15,
  strongExperiments: 2,
  minRelativeDifference: 0.15,
};

/**
 * Which metrics matter, per account goal.
 *
 * This is the guard against optimizing for vanity metrics: an account chasing
 * followers should not have its strategy rewritten because a post got likes.
 * Weights are relative, not probabilities.
 */
export const GOAL_METRIC_WEIGHTS: Record<string, Record<string, number>> = {
  follower_growth: { follows: 1.0, follow_conversion: 1.0, reach: 0.7, profile_views: 0.6, saves: 0.3, likes: 0.1 },
  engagement: { engagement_rate: 1.0, comments: 0.9, shares: 0.9, saves: 0.8, reach: 0.4, likes: 0.3 },
  reach: { reach: 1.0, views: 0.9, shares: 0.7, engagement_rate: 0.4, likes: 0.1 },
  saves: { save_rate: 1.0, saves: 1.0, engagement_rate: 0.5, reach: 0.4, likes: 0.1 },
};

/** Used when the account's goal metric is unrecognised — balanced, never likes-led. */
export const DEFAULT_GOAL_WEIGHTS: Record<string, number> = {
  reach: 0.8,
  engagement_rate: 0.8,
  follows: 0.7,
  saves: 0.6,
  shares: 0.6,
  comments: 0.5,
  likes: 0.2,
};

export function goalWeightsFor(goalMetric: string | null | undefined): Record<string, number> {
  if (!goalMetric) return DEFAULT_GOAL_WEIGHTS;
  const normalized = goalMetric.toLowerCase().replace(/[\s-]+/g, "_");
  return GOAL_METRIC_WEIGHTS[normalized] ?? DEFAULT_GOAL_WEIGHTS;
}

export interface DimensionObservation {
  /** e.g. "format" */
  dimension: string;
  /** e.g. "reel" */
  value: string;
  /** Per-post metric values for posts holding this dimension value. */
  metrics: Record<string, (number | undefined)[]>;
  contentPostIds: string[];
}

export interface ExperimentEvidence {
  experimentId: string;
  variable: string;
  outcome: string;
  primaryMetric: string;
  /** The arm value that won, when one did. */
  winningValue?: string | null;
  relativeLift?: number;
  confidence?: string;
  sampleSizes?: Record<string, number>;
}

export interface DimensionEvidence {
  dimension: string;
  value: string;
  observations: number;
  /** Median per metric across this dimension's posts. */
  medians: Record<string, number>;
  /** Ratio against the account-wide median for the same metric. */
  vsBaseline: Record<string, number>;
  /** Weighted score against the goal — the number that decides what matters. */
  goalScore?: number;
  supportingExperiments: ExperimentEvidence[];
  /** Experiments whose result points the other way, or that were inconclusive. */
  contradictingExperiments: ExperimentEvidence[];
  strength: EvidenceStrength;
  /** Plain statements the agent may quote; it must not invent its own. */
  evidenceStatements: string[];
  /** Facts that cut against the finding — supplied so the agent cannot ignore them. */
  contradictingStatements: string[];
}

export interface EvidenceReport {
  goalMetric: string | null;
  goalWeights: Record<string, number>;
  totalObservations: number;
  /** Ceiling across all dimensions — the run's overall evidence level. */
  overallStrength: EvidenceStrength;
  dimensions: DimensionEvidence[];
  experiments: ExperimentEvidence[];
  thresholds: EvidenceThresholds;
  /** Why the overall strength is what it is. */
  notes: string[];
}

export class EvidenceEvaluator {
  constructor(private readonly thresholds: EvidenceThresholds = DEFAULT_EVIDENCE_THRESHOLDS) {}

  evaluate(input: {
    observations: DimensionObservation[];
    /** Account-wide median per metric, for baseline comparison. */
    baseline: Record<string, number>;
    experiments: ExperimentEvidence[];
    goalMetric: string | null;
  }): EvidenceReport {
    const goalWeights = goalWeightsFor(input.goalMetric);
    const notes: string[] = [];

    const dimensions = input.observations.map((observation) =>
      this.evaluateDimension(observation, input.baseline, input.experiments, goalWeights),
    );

    const totalObservations = new Set(input.observations.flatMap((o) => o.contentPostIds)).size;

    // The run is only as strong as its strongest dimension, and never stronger
    // than the total evidence available.
    const rank: Record<EvidenceStrength, number> = { insufficient: 0, early_signal: 1, moderate: 2, strong: 3 };
    let overallStrength: EvidenceStrength = "insufficient";
    for (const dimension of dimensions) {
      if (rank[dimension.strength] > rank[overallStrength]) overallStrength = dimension.strength;
    }

    if (totalObservations < this.thresholds.minObservations) {
      overallStrength = "insufficient";
      notes.push(
        `Only ${totalObservations} measured post(s) across the account; at least ${this.thresholds.minObservations} are needed before any conclusion.`,
      );
    }

    if (dimensions.length === 0) {
      notes.push("No dimension had enough measured posts to compare.");
    }

    return {
      goalMetric: input.goalMetric,
      goalWeights,
      totalObservations,
      overallStrength,
      dimensions,
      experiments: input.experiments,
      thresholds: this.thresholds,
      notes,
    };
  }

  private evaluateDimension(
    observation: DimensionObservation,
    baseline: Record<string, number>,
    experiments: ExperimentEvidence[],
    goalWeights: Record<string, number>,
  ): DimensionEvidence {
    const medians: Record<string, number> = {};
    for (const [metric, values] of Object.entries(observation.metrics)) {
      const usable = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const value = median(usable);
      if (value !== undefined) medians[metric] = value;
    }

    const vsBaseline: Record<string, number> = {};
    for (const [metric, value] of Object.entries(medians)) {
      const base = baseline[metric];
      // Division by a zero baseline is undefined, not "infinitely better".
      if (base !== undefined && base !== 0) vsBaseline[metric] = value / base;
    }

    const observations = observation.contentPostIds.length;

    // Experiments that tested this same dimension are the strongest evidence
    // available, because they controlled for everything else.
    const relevant = experiments.filter((e) => e.variable === observation.dimension);
    const supporting = relevant.filter(
      (e) =>
        (e.outcome === "variant_winner" || e.outcome === "control_winner") &&
        e.winningValue?.toLowerCase() === observation.value.toLowerCase(),
    );
    const contradicting = relevant.filter((e) => !supporting.includes(e));

    const { evidenceStatements, contradictingStatements } = this.buildStatements(
      observation,
      medians,
      vsBaseline,
      goalWeights,
      supporting,
      contradicting,
      observations,
    );

    return {
      dimension: observation.dimension,
      value: observation.value,
      observations,
      medians,
      vsBaseline,
      goalScore: this.goalScore(vsBaseline, goalWeights),
      supportingExperiments: supporting,
      contradictingExperiments: contradicting,
      strength: this.strengthFor(observations, vsBaseline, supporting.length, goalWeights),
      evidenceStatements,
      contradictingStatements,
    };
  }

  /**
   * Weighted average of baseline ratios, using only metrics the goal cares
   * about. Returns undefined when no goal-relevant metric was measurable —
   * a dimension cannot be judged on metrics that do not exist.
   */
  private goalScore(vsBaseline: Record<string, number>, goalWeights: Record<string, number>): number | undefined {
    let weighted = 0;
    let totalWeight = 0;
    for (const [metric, ratio] of Object.entries(vsBaseline)) {
      const weight = goalWeights[metric];
      if (weight === undefined) continue;
      weighted += weight * ratio;
      totalWeight += weight;
    }
    return totalWeight > 0 ? weighted / totalWeight : undefined;
  }

  private strengthFor(
    observations: number,
    vsBaseline: Record<string, number>,
    supportingExperiments: number,
    goalWeights: Record<string, number>,
  ): EvidenceStrength {
    if (observations < this.thresholds.minObservations) return "insufficient";

    // A difference smaller than the threshold is noise regardless of sample size.
    const meaningful = Object.entries(vsBaseline).some(
      ([metric, ratio]) =>
        goalWeights[metric] !== undefined && Math.abs(ratio - 1) >= this.thresholds.minRelativeDifference,
    );
    if (!meaningful) return "early_signal";

    if (observations >= this.thresholds.strongObservations && supportingExperiments >= this.thresholds.strongExperiments) {
      return "strong";
    }
    if (observations >= this.thresholds.moderateObservations) return "moderate";
    return "early_signal";
  }

  /**
   * Pre-written statements of fact. The agent quotes these rather than
   * composing its own numbers, which is what stops it citing figures that
   * were never measured.
   */
  private buildStatements(
    observation: DimensionObservation,
    medians: Record<string, number>,
    vsBaseline: Record<string, number>,
    goalWeights: Record<string, number>,
    supporting: ExperimentEvidence[],
    contradicting: ExperimentEvidence[],
    observations: number,
  ): { evidenceStatements: string[]; contradictingStatements: string[] } {
    const evidenceStatements: string[] = [`${observations} measured post(s) with ${observation.dimension}=${observation.value}`];
    const contradictingStatements: string[] = [];

    for (const [metric, ratio] of Object.entries(vsBaseline)) {
      if (goalWeights[metric] === undefined) continue;
      const statement = `${metric} ${ratio.toFixed(2)}x the account median (${format(medians[metric]!)})`;
      // Both directions are recorded, so the agent sees what argues against it.
      if (ratio >= 1 + this.thresholds.minRelativeDifference) evidenceStatements.push(statement);
      else if (ratio <= 1 - this.thresholds.minRelativeDifference) contradictingStatements.push(statement);
    }

    for (const experiment of supporting) {
      evidenceStatements.push(
        `experiment "${experiment.variable}" favoured ${experiment.winningValue} on ${experiment.primaryMetric}` +
          (experiment.relativeLift !== undefined ? ` (${(experiment.relativeLift * 100).toFixed(0)}%)` : ""),
      );
    }

    for (const experiment of contradicting) {
      contradictingStatements.push(
        experiment.outcome === "variant_winner" || experiment.outcome === "control_winner"
          ? `experiment "${experiment.variable}" favoured ${experiment.winningValue}, not ${observation.value}`
          : `experiment "${experiment.variable}" was ${experiment.outcome.replace(/_/g, " ")}`,
      );
    }

    return { evidenceStatements, contradictingStatements };
  }
}

function format(value: number): string {
  return Math.abs(value) < 1 && value !== 0 ? value.toFixed(4) : value.toLocaleString();
}
