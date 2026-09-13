/**
 * The single source of truth for what an experiment may vary and how it may
 * be judged.
 *
 * Everything else in the experiment engine reads from here rather than
 * repeating string literals, so adding a variable is one entry in this file —
 * not a search across the codebase. The LLM proposes against this list; it
 * never extends it.
 */

export const EXPERIMENT_VARIABLES = [
  "format",
  "topic",
  "hook",
  "cta",
  "caption_style",
  "posting_time",
] as const;

export type ExperimentVariable = (typeof EXPERIMENT_VARIABLES)[number];

export interface ExperimentVariableDefinition {
  name: ExperimentVariable;
  label: string;
  /** How the variant's value is applied when generating content for that arm. */
  appliesTo: "content_brief" | "schedule";
  /** Metrics that make sense as a primary metric for this variable. Advisory, not enforced. */
  suggestedMetrics: string[];
  description: string;
}

export const EXPERIMENT_VARIABLE_DEFINITIONS: Record<ExperimentVariable, ExperimentVariableDefinition> = {
  format: {
    name: "format",
    label: "Content format",
    appliesTo: "content_brief",
    suggestedMetrics: ["reach", "share_rate", "engagement_rate"],
    description: "Reel vs carousel vs single image.",
  },
  topic: {
    name: "topic",
    label: "Topic / content pillar",
    appliesTo: "content_brief",
    suggestedMetrics: ["reach", "follow_conversion", "engagement_rate"],
    description: "One subject area against another.",
  },
  hook: {
    name: "hook",
    label: "Hook style",
    appliesTo: "content_brief",
    suggestedMetrics: ["save_rate", "engagement_rate", "reach"],
    description: "How the first line frames the content, e.g. generic vs pain-point.",
  },
  cta: {
    name: "cta",
    label: "Call to action",
    appliesTo: "content_brief",
    suggestedMetrics: ["profile_views", "follow_conversion", "save_rate"],
    description: "What the post asks the reader to do.",
  },
  caption_style: {
    name: "caption_style",
    label: "Caption style",
    appliesTo: "content_brief",
    suggestedMetrics: ["engagement_rate", "save_rate"],
    description: "Long-form vs short-form caption.",
  },
  posting_time: {
    name: "posting_time",
    label: "Posting time",
    appliesTo: "schedule",
    suggestedMetrics: ["reach", "engagement_rate"],
    description: "Time of day a post goes out. Varies the schedule, not the brief.",
  },
};

/**
 * Metrics an experiment may be judged on. Deliberately restricted to what
 * Phase 5 actually measures or derives — an experiment cannot be scored on a
 * metric the analytics layer never produces.
 *
 * Rates are preferred as primary metrics because they are comparable across
 * posts with different distribution; raw counts are allowed but noted.
 */
export const EXPERIMENT_METRICS = [
  // derived rates (comparable across posts)
  "engagement_rate",
  "share_rate",
  "save_rate",
  "follow_conversion",
  "views_to_follow_conversion",
  // raw counts
  "reach",
  "views",
  "likes",
  "comments",
  "shares",
  "saves",
  "follows",
  "total_interactions",
  "profile_views",
] as const;

export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];

/** Rates normalize for distribution; counts do not. Used to caveat conclusions. */
export const RATE_METRICS: ReadonlySet<string> = new Set([
  "engagement_rate",
  "share_rate",
  "save_rate",
  "follow_conversion",
  "views_to_follow_conversion",
]);

export function isExperimentVariable(value: string): value is ExperimentVariable {
  return (EXPERIMENT_VARIABLES as readonly string[]).includes(value);
}

export function isExperimentMetric(value: string): value is ExperimentMetric {
  return (EXPERIMENT_METRICS as readonly string[]).includes(value);
}

/**
 * Runtime limits. All configurable: these are development defaults chosen to
 * keep a POC honest and cheap, not statistically universal rules.
 */
export interface ExperimentLimits {
  /** Minimum posts per arm before any winner may be declared. */
  minSamplesPerVariant: number;
  /** Relative difference below which the result is "no clear winner". */
  minRelativeLift: number;
  /** How long an arm is observed after publication before it counts. */
  observationWindowHours: number;
  maxDurationDays: number;
  maxActiveExperimentsPerAccount: number;
  maxExperimentContentPerDay: number;
  /**
   * Tolerated imbalance between arms. 8 vs 1 is not a comparison, so an
   * experiment whose arms are more lopsided than this is not concluded.
   */
  maxSampleImbalanceRatio: number;
}

export const DEFAULT_EXPERIMENT_LIMITS: ExperimentLimits = {
  minSamplesPerVariant: 5,
  minRelativeLift: 0.1,
  observationWindowHours: 24,
  maxDurationDays: 14,
  maxActiveExperimentsPerAccount: 1,
  maxExperimentContentPerDay: 4,
  maxSampleImbalanceRatio: 2,
};

export const VARIANT_ROLES = ["control", "variant"] as const;
export type VariantRole = (typeof VARIANT_ROLES)[number];

export const EXPERIMENT_OUTCOMES = [
  "variant_winner",
  "control_winner",
  "no_clear_winner",
  "inconclusive",
  "insufficient_data",
] as const;

export type ExperimentOutcome = (typeof EXPERIMENT_OUTCOMES)[number];

export type ExperimentConfidence = "low" | "medium" | "high";
