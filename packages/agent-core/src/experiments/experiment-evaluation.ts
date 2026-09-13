import { median } from "../analytics/derived-metrics.js";
import {
  RATE_METRICS,
  type ExperimentConfidence,
  type ExperimentLimits,
  type ExperimentOutcome,
} from "./experiment-config.js";

/**
 * Deterministic comparison of experiment arms.
 *
 * No LLM is involved. The same samples always produce the same verdict, which
 * is what makes a result auditable and what makes re-evaluation idempotent.
 *
 * The vocabulary is deliberately cautious. This performs no significance test,
 * so it never says "proven" or "significant" — it reports a directional winner,
 * no clear winner, or inconclusive, and records exactly which rule fired.
 */

export interface VariantSample {
  variantId: string;
  name: string;
  role: "control" | "variant";
  variableValue: string | null;
  /** One entry per published post in this arm; undefined where the metric was unavailable. */
  values: (number | undefined)[];
  contentPostIds: string[];
}

export interface EvaluationInput {
  primaryMetric: string;
  secondaryMetrics?: Record<string, VariantSample[]>;
  samples: VariantSample[];
  limits: Pick<ExperimentLimits, "minSamplesPerVariant" | "minRelativeLift" | "maxSampleImbalanceRatio">;
}

export interface VariantSummary {
  variantId: string;
  name: string;
  role: "control" | "variant";
  variableValue: string | null;
  /** Posts in this arm that actually reported the primary metric. */
  observations: number;
  /** Posts assigned to this arm, whether or not they reported the metric. */
  assigned: number;
  median?: number;
  mean?: number;
  min?: number;
  max?: number;
}

export interface EvaluationResult {
  outcome: ExperimentOutcome;
  primaryMetric: string;
  controlValue?: number;
  variantValue?: number;
  relativeLift?: number;
  confidence: ExperimentConfidence;
  conclusion: string;
  /** Which arm won, when one did. */
  winner?: "control" | "variant";
  winningVariantId?: string;
  summaries: VariantSummary[];
  sampleSizes: Record<string, number>;
  /** Every threshold applied, so the verdict can be re-derived later. */
  thresholds: {
    minSamplesPerVariant: number;
    minRelativeLift: number;
    maxSampleImbalanceRatio: number;
  };
  /** Why the outcome is what it is, in the order the rules were applied. */
  reasons: string[];
  /** Stable for a given set of sample counts — the idempotency key. */
  evaluationKey: string;
}

export class ExperimentEvaluationService {
  evaluate(input: EvaluationInput): EvaluationResult {
    const { primaryMetric, samples, limits } = input;
    const reasons: string[] = [];

    const summaries = samples.map((sample) => summarize(sample));
    const sampleSizes = Object.fromEntries(summaries.map((s) => [s.name, s.observations]));
    const evaluationKey = buildEvaluationKey(primaryMetric, summaries);

    const base = {
      primaryMetric,
      summaries,
      sampleSizes,
      thresholds: {
        minSamplesPerVariant: limits.minSamplesPerVariant,
        minRelativeLift: limits.minRelativeLift,
        maxSampleImbalanceRatio: limits.maxSampleImbalanceRatio,
      },
      evaluationKey,
    };

    const control = summaries.find((s) => s.role === "control");
    const variants = summaries.filter((s) => s.role === "variant");

    if (!control || variants.length === 0) {
      return {
        ...base,
        outcome: "insufficient_data",
        confidence: "low",
        reasons: ["The experiment does not have both a control and a variant arm with data."],
        conclusion: "Cannot evaluate: the experiment is missing a control or variant arm.",
      };
    }

    // Rule 1 — sample requirement. Checked before anything else, because a
    // large apparent difference over two posts is still noise.
    const underpowered = summaries.filter((s) => s.observations < limits.minSamplesPerVariant);
    if (underpowered.length > 0) {
      reasons.push(
        `Sample requirement not met: ${underpowered
          .map((s) => `${s.name} has ${s.observations}/${limits.minSamplesPerVariant}`)
          .join(", ")}.`,
      );
      return {
        ...base,
        outcome: "insufficient_data",
        confidence: "low",
        reasons,
        controlValue: control.median,
        variantValue: variants[0]?.median,
        conclusion: `Not enough observations yet — each arm needs at least ${limits.minSamplesPerVariant} measured posts. Any apparent difference at this size is not distinguishable from noise.`,
      };
    }

    // Rule 2 — balance. 8 vs 1 is not a comparison even when both clear the
    // minimum, because the larger arm's median is far better established.
    const counts = summaries.map((s) => s.observations);
    const imbalance = Math.max(...counts) / Math.max(1, Math.min(...counts));
    if (imbalance > limits.maxSampleImbalanceRatio) {
      reasons.push(
        `Arms are unbalanced (${counts.join(" vs ")}), beyond the ${limits.maxSampleImbalanceRatio}x tolerance.`,
      );
      return {
        ...base,
        outcome: "inconclusive",
        confidence: "low",
        reasons,
        controlValue: control.median,
        variantValue: variants[0]?.median,
        conclusion:
          "Arms received very different numbers of posts, so the comparison is not fair. Publish more of the smaller arm before concluding.",
      };
    }

    // Rule 3 — the metric must actually exist on both sides.
    const best = variants
      .filter((v) => v.median !== undefined)
      .sort((a, b) => (b.median ?? 0) - (a.median ?? 0))[0];

    if (control.median === undefined || !best || best.median === undefined) {
      reasons.push(`The primary metric "${primaryMetric}" was unavailable for at least one arm.`);
      return {
        ...base,
        outcome: "insufficient_data",
        confidence: "low",
        reasons,
        conclusion: `Cannot compare: "${primaryMetric}" was not reported for every arm. This is common when a post had no reach, which makes rate metrics undefined.`,
      };
    }

    // Rule 4 — relative lift against the control. Division by a zero control
    // is undefined, not "infinite improvement".
    if (control.median === 0) {
      reasons.push("The control arm's median is 0, so relative lift is undefined.");
      const variantMoved = best.median > 0;
      return {
        ...base,
        outcome: variantMoved ? "inconclusive" : "no_clear_winner",
        confidence: "low",
        controlValue: control.median,
        variantValue: best.median,
        reasons,
        conclusion: variantMoved
          ? `The control scored 0 for ${primaryMetric} while the variant scored ${format(best.median)}. A ratio cannot be computed against zero, so this is a directional signal only.`
          : `Both arms scored 0 for ${primaryMetric}. There is nothing to distinguish them.`,
      };
    }

    const relativeLift = (best.median - control.median) / Math.abs(control.median);
    const magnitude = Math.abs(relativeLift);

    if (magnitude < limits.minRelativeLift) {
      reasons.push(
        `Difference of ${(relativeLift * 100).toFixed(1)}% is below the ${(limits.minRelativeLift * 100).toFixed(0)}% minimum lift.`,
      );
      return {
        ...base,
        outcome: "no_clear_winner",
        confidence: confidenceFor(summaries, limits, magnitude),
        controlValue: control.median,
        variantValue: best.median,
        relativeLift,
        reasons,
        conclusion: `No clear winner: ${primaryMetric} differed by ${(relativeLift * 100).toFixed(1)}%, below the ${(limits.minRelativeLift * 100).toFixed(0)}% threshold considered meaningful.`,
      };
    }

    const variantWon = relativeLift > 0;
    const confidence = confidenceFor(summaries, limits, magnitude);
    reasons.push(
      `${variantWon ? "Variant" : "Control"} exceeded the other by ${(magnitude * 100).toFixed(1)}%, above the ${(limits.minRelativeLift * 100).toFixed(0)}% threshold.`,
    );
    if (!RATE_METRICS.has(primaryMetric)) {
      reasons.push(`"${primaryMetric}" is a raw count, so differences in distribution between posts are not normalized out.`);
    }

    return {
      ...base,
      outcome: variantWon ? "variant_winner" : "control_winner",
      winner: variantWon ? "variant" : "control",
      winningVariantId: variantWon ? best.variantId : control.variantId,
      confidence,
      controlValue: control.median,
      variantValue: best.median,
      relativeLift,
      reasons,
      // "Directional", never "proven": no significance test was performed.
      conclusion: `Directional ${variantWon ? "winner: " + best.name : "result: the control"} — median ${primaryMetric} of ${format(
        variantWon ? best.median : control.median,
      )} against ${format(variantWon ? control.median : best.median)}, a ${(magnitude * 100).toFixed(1)}% difference over ${
        control.observations
      } vs ${best.observations} posts. This is a directional signal, not a statistically tested result.`,
    };
  }
}

/**
 * Confidence is computed, never supplied by a model. It rises with sample size
 * and effect size, and is capped at "medium" because no significance test is
 * performed — claiming "high" from a median comparison would overstate what
 * this method can support.
 */
function confidenceFor(
  summaries: VariantSummary[],
  limits: Pick<ExperimentLimits, "minSamplesPerVariant">,
  magnitude: number,
): ExperimentConfidence {
  const smallest = Math.min(...summaries.map((s) => s.observations));
  const comfortable = smallest >= limits.minSamplesPerVariant * 2;
  const strongEffect = magnitude >= 0.25;

  if (comfortable && strongEffect) return "medium";
  if (smallest >= limits.minSamplesPerVariant && (strongEffect || comfortable)) return "medium";
  return "low";
}

function summarize(sample: VariantSample): VariantSummary {
  const values = sample.values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return {
    variantId: sample.variantId,
    name: sample.name,
    role: sample.role,
    variableValue: sample.variableValue,
    assigned: sample.contentPostIds.length,
    observations: values.length,
    // Median for the same reason the analytics baseline uses it: one outlier
    // post should not decide an experiment.
    median: median(values),
    mean: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : undefined,
    min: values.length > 0 ? Math.min(...values) : undefined,
    max: values.length > 0 ? Math.max(...values) : undefined,
  };
}

/**
 * Deterministic from the metric and each arm's observation count. Re-running
 * an evaluation over unchanged data yields the same key, and the UNIQUE
 * constraint turns the second write into a no-op instead of a duplicate row.
 */
function buildEvaluationKey(primaryMetric: string, summaries: VariantSummary[]): string {
  const counts = [...summaries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `${s.name}:${s.observations}`)
    .join("|");
  return `${primaryMetric}#${counts}`;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}
