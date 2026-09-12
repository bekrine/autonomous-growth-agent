import { compareToBaseline, median } from "./derived-metrics.js";
import type { NormalizedMetric } from "./normalization.js";

/**
 * Baseline + performance scoring.
 *
 * Both are configuration, not business rules baked into code: weights and the
 * baseline window are injected so they can be tuned without a code change, and
 * so Phase 6/7 can experiment with them.
 */

export interface PerformanceWeights {
  reach: number;
  engagement: number;
  shares: number;
  saves: number;
  follows: number;
}

export const DEFAULT_PERFORMANCE_WEIGHTS: PerformanceWeights = {
  reach: 0.3,
  engagement: 0.2,
  shares: 0.2,
  saves: 0.15,
  follows: 0.15,
};

/** Median of recent eligible posts, per metric. */
export interface AccountBaseline {
  sampleSize: number;
  windowPostCount: number;
  metrics: Record<string, number>;
  computedAt: string;
}

export interface PostMetricSample {
  contentPostId: string;
  metrics: Record<string, number | undefined>;
}

const BASELINE_METRICS = ["reach", "views", "likes", "comments", "shares", "saves", "follows", "engagement_rate"];

/**
 * Builds a baseline from the most recent posts. Each metric is medianed
 * independently over the posts that actually reported it, so one post missing
 * `saves` does not shrink the sample for `reach`.
 */
export function calculateAccountBaseline(samples: PostMetricSample[], windowPostCount: number): AccountBaseline {
  const window = samples.slice(0, windowPostCount);
  const metrics: Record<string, number> = {};

  for (const name of BASELINE_METRICS) {
    const values = window
      .map((sample) => sample.metrics[name])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const value = median(values);
    if (value !== undefined) metrics[name] = value;
  }

  return {
    sampleSize: window.length,
    windowPostCount,
    metrics,
    computedAt: new Date().toISOString(),
  };
}

export interface PerformanceScoreResult {
  available: boolean;
  score?: number;
  /** Which components contributed, and what each was worth. */
  components: {
    name: string;
    weight: number;
    normalized?: number;
    available: boolean;
    reason?: string;
  }[];
  /** Weight actually applied — below 1 when some metrics were unavailable. */
  coverage: number;
  formula: string;
  unavailableReason?: string;
}

const COMPONENT_METRICS: Record<keyof PerformanceWeights, string> = {
  reach: "reach",
  engagement: "engagement_rate",
  shares: "shares",
  saves: "saves",
  follows: "follows",
};

/**
 * Scores a post against the account baseline.
 *
 * Each component is the post's value over the baseline median, so 1.0 means
 * "typical for this account" — an absolute threshold would be meaningless
 * across accounts of different sizes.
 *
 * Components whose metric or baseline is missing are dropped and the remaining
 * weights are renormalized, with `coverage` reporting how much of the formula
 * was actually available. A score computed from one of five components is not
 * presented as equivalent to a complete one.
 */
export function calculatePerformanceScore(
  postMetrics: Record<string, number | undefined>,
  baseline: AccountBaseline,
  weights: PerformanceWeights = DEFAULT_PERFORMANCE_WEIGHTS,
): PerformanceScoreResult {
  const formula = Object.entries(weights)
    .map(([name, weight]) => `${weight} x normalized_${name}`)
    .join(" + ");

  const components: PerformanceScoreResult["components"] = [];
  let weightedSum = 0;
  let appliedWeight = 0;

  for (const [component, weight] of Object.entries(weights) as [keyof PerformanceWeights, number][]) {
    const metricName = COMPONENT_METRICS[component];
    const value = postMetrics[metricName];
    const baselineValue = baseline.metrics[metricName];
    const comparison = compareToBaseline(value, baselineValue, metricName);

    if (!comparison.available || comparison.value === undefined) {
      components.push({ name: component, weight, available: false, reason: comparison.unavailableReason });
      continue;
    }

    components.push({ name: component, weight, normalized: comparison.value, available: true });
    weightedSum += weight * comparison.value;
    appliedWeight += weight;
  }

  if (appliedWeight === 0) {
    return {
      available: false,
      components,
      coverage: 0,
      formula,
      unavailableReason: "No scoreable metrics were available for this post",
    };
  }

  return {
    available: true,
    score: weightedSum / appliedWeight,
    components,
    coverage: appliedWeight,
    formula,
  };
}
