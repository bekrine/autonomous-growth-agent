import { describe, expect, it } from "vitest";
import { ExperimentEvaluationService, type VariantSample } from "../experiments/experiment-evaluation.js";
import { assignSlots, buildBalancedQueue } from "../experiments/variant-assignment.js";

const evaluator = new ExperimentEvaluationService();

const LIMITS = { minSamplesPerVariant: 5, minRelativeLift: 0.1, maxSampleImbalanceRatio: 2 };

function arm(name: string, role: "control" | "variant", values: (number | undefined)[]): VariantSample {
  return {
    variantId: `${name}-id`,
    name,
    role,
    variableValue: name,
    values,
    contentPostIds: values.map((_, i) => `${name}-post-${i}`),
  };
}

function evaluate(samples: VariantSample[], limits = LIMITS) {
  return evaluator.evaluate({ primaryMetric: "save_rate", samples, limits });
}

describe("sample-size protection", () => {
  it("refuses to name a winner from tiny samples, however large the apparent gap", () => {
    // The variant looks 5x better. With two posts per arm that is noise.
    const result = evaluate([arm("control", "control", [0.01, 0.01]), arm("variant", "variant", [0.05, 0.05])]);

    expect(result.outcome).toBe("insufficient_data");
    expect(result.winner).toBeUndefined();
    expect(result.confidence).toBe("low");
    expect(result.conclusion).toContain("not distinguishable from noise");
  });

  it("counts only posts that actually reported the metric", () => {
    // Six posts per arm, but most had no measurable value.
    const result = evaluate([
      arm("control", "control", [0.02, undefined, undefined, undefined, undefined, undefined]),
      arm("variant", "variant", [0.09, undefined, undefined, undefined, undefined, undefined]),
    ]);

    expect(result.outcome).toBe("insufficient_data");
    expect(result.sampleSizes).toEqual({ control: 1, variant: 1 });
    // Assigned vs observed are tracked separately so the gap is visible.
    expect(result.summaries[0]!.assigned).toBe(6);
    expect(result.summaries[0]!.observations).toBe(1);
  });
});

describe("winner selection", () => {
  const control = arm("control", "control", [0.04, 0.042, 0.038, 0.041, 0.039]);

  it("names a directional variant winner when the lift clears the threshold", () => {
    const result = evaluate([control, arm("variant", "variant", [0.07, 0.072, 0.069, 0.071, 0.07])]);

    expect(result.outcome).toBe("variant_winner");
    expect(result.winner).toBe("variant");
    expect(result.relativeLift).toBeGreaterThan(0.1);
    // Never overstated: no significance test was performed.
    expect(result.conclusion).toContain("directional signal, not a statistically tested result");
    expect(result.conclusion.toLowerCase()).not.toContain("proven");
    expect(result.conclusion.toLowerCase()).not.toContain("significant");
  });

  it("names the control when it outperforms the variant", () => {
    const result = evaluate([control, arm("variant", "variant", [0.02, 0.021, 0.019, 0.02, 0.02])]);

    expect(result.outcome).toBe("control_winner");
    expect(result.winner).toBe("control");
    expect(result.relativeLift).toBeLessThan(0);
  });

  it("reports no clear winner when the difference is below the minimum lift", () => {
    const result = evaluate([control, arm("variant", "variant", [0.042, 0.043, 0.041, 0.042, 0.042])]);

    expect(result.outcome).toBe("no_clear_winner");
    expect(result.winner).toBeUndefined();
    expect(result.reasons.join(" ")).toContain("below the 10% minimum lift");
  });

  it("keeps thresholds configurable", () => {
    // Control median is 0.04; 0.043 is a 7.5% lift — under the 10% default,
    // over a 2% threshold.
    const samples = [control, arm("variant", "variant", [0.043, 0.043, 0.043, 0.043, 0.043])];

    expect(evaluate(samples).outcome).toBe("no_clear_winner");
    expect(evaluate(samples, { ...LIMITS, minRelativeLift: 0.02 }).outcome).toBe("variant_winner");
  });
});

describe("balance protection", () => {
  it("refuses to conclude when one arm has far more posts than the other", () => {
    const result = evaluate([
      arm("control", "control", [0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04]),
      arm("variant", "variant", [0.09, 0.09, 0.09, 0.09, 0.09]),
    ]);

    // 8 vs 5 is within 2x, so this one is allowed through.
    expect(result.outcome).toBe("variant_winner");

    const lopsided = evaluate([
      arm("control", "control", Array.from({ length: 20 }, () => 0.04)),
      arm("variant", "variant", [0.09, 0.09, 0.09, 0.09, 0.09]),
    ]);
    expect(lopsided.outcome).toBe("inconclusive");
    expect(lopsided.conclusion).toContain("not fair");
  });
});

describe("zero and missing denominators", () => {
  it("does not report infinite improvement when the control is zero", () => {
    const result = evaluate([
      arm("control", "control", [0, 0, 0, 0, 0]),
      arm("variant", "variant", [0.05, 0.05, 0.05, 0.05, 0.05]),
    ]);

    expect(result.outcome).toBe("inconclusive");
    expect(result.relativeLift).toBeUndefined();
    expect(result.conclusion).toContain("cannot be computed against zero");
    expect(Number.isFinite(result.relativeLift ?? 0)).toBe(true);
  });

  it("reports no clear winner when both arms are zero", () => {
    const result = evaluate([
      arm("control", "control", [0, 0, 0, 0, 0]),
      arm("variant", "variant", [0, 0, 0, 0, 0]),
    ]);

    expect(result.outcome).toBe("no_clear_winner");
    expect(result.conclusion).toContain("nothing to distinguish them");
  });

  it("reports insufficient data when the metric is missing from an arm entirely", () => {
    const result = evaluate([
      arm("control", "control", [0.04, 0.04, 0.04, 0.04, 0.04]),
      arm("variant", "variant", [undefined, undefined, undefined, undefined, undefined]),
    ]);

    expect(result.outcome).toBe("insufficient_data");
  });

  it("cannot evaluate without both a control and a variant", () => {
    const result = evaluate([arm("control", "control", [0.04, 0.04, 0.04, 0.04, 0.04])]);
    expect(result.outcome).toBe("insufficient_data");
    expect(result.conclusion).toContain("missing a control or variant arm");
  });
});

describe("confidence", () => {
  it("is computed, capped at medium, and never high", () => {
    const strong = evaluate([
      arm("control", "control", Array.from({ length: 12 }, () => 0.04)),
      arm("variant", "variant", Array.from({ length: 12 }, () => 0.09)),
    ]);

    // Large sample, large effect — still only "medium", because this is a
    // median comparison, not a significance test.
    expect(strong.confidence).toBe("medium");
    expect(strong.confidence).not.toBe("high");
  });

  it("is low when samples only just clear the minimum with a small effect", () => {
    const marginal = evaluate([
      arm("control", "control", [0.04, 0.04, 0.04, 0.04, 0.04]),
      arm("variant", "variant", [0.046, 0.046, 0.046, 0.046, 0.046]),
    ]);
    expect(marginal.outcome).toBe("variant_winner");
    expect(marginal.confidence).toBe("low");
  });
});

describe("robustness and auditability", () => {
  it("uses the median so one viral post cannot decide an experiment", () => {
    const result = evaluate([
      arm("control", "control", [0.04, 0.04, 0.04, 0.04, 0.04]),
      // Four ordinary posts and one enormous outlier: the mean would swing the
      // verdict, the median should not.
      arm("variant", "variant", [0.04, 0.04, 0.04, 0.04, 9.0]),
    ]);

    expect(result.variantValue).toBe(0.04);
    expect(result.outcome).toBe("no_clear_winner");
  });

  it("records every threshold applied so the verdict can be re-derived", () => {
    const result = evaluate([
      arm("control", "control", Array.from({ length: 5 }, () => 0.04)),
      arm("variant", "variant", Array.from({ length: 5 }, () => 0.08)),
    ]);

    expect(result.thresholds).toEqual(LIMITS);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("produces a stable evaluation key for unchanged data — the idempotency guard", () => {
    const samples = [
      arm("control", "control", Array.from({ length: 5 }, () => 0.04)),
      arm("variant", "variant", Array.from({ length: 5 }, () => 0.08)),
    ];

    expect(evaluate(samples).evaluationKey).toBe(evaluate(samples).evaluationKey);

    // A new post changes the key, so a genuinely new evaluation is recorded.
    const more = [samples[0]!, arm("variant", "variant", Array.from({ length: 6 }, () => 0.08))];
    expect(evaluate(more).evaluationKey).not.toBe(evaluate(samples).evaluationKey);
  });

  it("warns when the primary metric is a raw count", () => {
    const result = evaluator.evaluate({
      primaryMetric: "likes",
      limits: LIMITS,
      samples: [
        arm("control", "control", Array.from({ length: 5 }, () => 10)),
        arm("variant", "variant", Array.from({ length: 5 }, () => 20)),
      ],
    });

    expect(result.reasons.join(" ")).toContain("raw count");
  });
});

describe("variant assignment", () => {
  const variants = [
    { id: "c", name: "control", role: "control" as const },
    { id: "v", name: "variant", role: "variant" as const },
  ];

  it("interleaves arms so time of day does not become the variable", () => {
    const slots = assignSlots(variants, 6);
    expect(slots.map((s) => s.variantId)).toEqual(["c", "v", "c", "v", "c", "v"]);
  });

  it("is deterministic and independent of input order", () => {
    const forward = assignSlots(variants, 4).map((s) => s.variantId);
    const reversed = assignSlots([...variants].reverse(), 4).map((s) => s.variantId);
    expect(forward).toEqual(reversed);
  });

  it("skips cancelled arms", () => {
    const slots = assignSlots([variants[0]!, { ...variants[1]!, status: "cancelled" }], 3);
    expect(new Set(slots.map((s) => s.variantId))).toEqual(new Set(["c"]));
  });

  it("tops up whichever arm is behind rather than restarting the cycle", () => {
    // Control already has 4 posts, variant has 1; target is 5.
    const queue = buildBalancedQueue(variants, { c: 4, v: 1 }, 5);

    expect(queue).toHaveLength(5);
    // The lagging arm goes first and gets the lion's share.
    expect(queue[0]!.variantId).toBe("v");
    expect(queue.filter((q) => q.variantId === "v")).toHaveLength(4);
    expect(queue.filter((q) => q.variantId === "c")).toHaveLength(1);
  });

  it("returns nothing once both arms have met the target", () => {
    expect(buildBalancedQueue(variants, { c: 5, v: 5 }, 5)).toEqual([]);
  });
});
