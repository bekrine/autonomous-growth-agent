import { metricValue, type NormalizedMetric } from "./normalization.js";

/**
 * Deterministic, application-side calculations. No LLM is involved: these are
 * arithmetic, and they must produce the same answer every time so that two
 * posts can be compared honestly.
 *
 * The governing rule is **no false precision**. A rate whose denominator is
 * missing or zero is reported as unavailable, never as 0%. Returning 0% for
 * "reach was 0" would make a post with no distribution look identical to a
 * post that reached thousands and engaged nobody.
 *
 * Every derived metric records its formula and inputs, so any number on the
 * dashboard can be audited back to the measurements it came from.
 */

export interface DerivedMetricDefinition {
  name: string;
  formula: string;
  /** Canonical metric names summed for the numerator. */
  numerator: string[];
  denominator: string;
}

export const DERIVED_METRIC_DEFINITIONS: DerivedMetricDefinition[] = [
  {
    name: "engagement_rate",
    formula: "(likes + comments + shares + saves) / reach",
    numerator: ["likes", "comments", "shares", "saves"],
    denominator: "reach",
  },
  { name: "share_rate", formula: "shares / reach", numerator: ["shares"], denominator: "reach" },
  { name: "save_rate", formula: "saves / reach", numerator: ["saves"], denominator: "reach" },
  { name: "follow_conversion", formula: "follows / reach", numerator: ["follows"], denominator: "reach" },
  {
    name: "views_to_follow_conversion",
    formula: "follows / views",
    numerator: ["follows"],
    denominator: "views",
  },
];

export function calculateDerivedMetrics(metrics: NormalizedMetric[]): NormalizedMetric[] {
  return DERIVED_METRIC_DEFINITIONS.map((definition) => calculateRate(metrics, definition));
}

function calculateRate(metrics: NormalizedMetric[], definition: DerivedMetricDefinition): NormalizedMetric {
  const denominator = metricValue(metrics, definition.denominator);

  const base: NormalizedMetric = {
    name: definition.name,
    platformName: definition.name,
    unit: "ratio",
    available: false,
    source: "derived",
  };

  if (denominator === undefined) {
    return { ...base, unavailableReason: `Cannot compute: ${definition.denominator} is unavailable` };
  }
  if (denominator === 0) {
    // Division by zero is undefined, not zero. Saying "0% engagement" for a
    // post nobody saw would be a claim the data does not support.
    return { ...base, unavailableReason: `Cannot compute: ${definition.denominator} is 0` };
  }

  // Every numerator component must be present. Summing only the available ones
  // would understate the rate while looking authoritative.
  const inputs: Record<string, number> = {};
  for (const name of definition.numerator) {
    const value = metricValue(metrics, name);
    if (value === undefined) {
      return { ...base, unavailableReason: `Cannot compute: ${name} is unavailable` };
    }
    inputs[name] = value;
  }

  const numerator = Object.values(inputs).reduce((sum, value) => sum + value, 0);
  inputs[definition.denominator] = denominator;

  return {
    ...base,
    value: numerator / denominator,
    available: true,
    computation: { formula: definition.formula, inputs },
  };
}

/**
 * Ratio of a value to a baseline, e.g. reach 8400 against baseline 3100 = 2.71x.
 * Unavailable when either side is missing or the baseline is 0 — "infinitely
 * better than zero" is not a useful or honest comparison.
 */
export function compareToBaseline(
  value: number | undefined,
  baseline: number | undefined,
  metricName: string,
): NormalizedMetric {
  const name = `${metricName}_vs_baseline`;
  const base: NormalizedMetric = {
    name,
    platformName: name,
    unit: "ratio",
    available: false,
    source: "derived",
  };

  if (value === undefined) return { ...base, unavailableReason: `Cannot compare: ${metricName} is unavailable` };
  if (baseline === undefined) return { ...base, unavailableReason: `Cannot compare: no baseline for ${metricName}` };
  if (baseline === 0) return { ...base, unavailableReason: `Cannot compare: baseline ${metricName} is 0` };

  return {
    ...base,
    value: value / baseline,
    available: true,
    computation: { formula: `${metricName} / baseline_${metricName}`, inputs: { value, baseline } },
  };
}

/**
 * Median, not mean: a single viral post would drag an average baseline far
 * above what typical content achieves, making every normal post look like a
 * failure.
 */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
