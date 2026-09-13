import { describe, expect, it } from "vitest";
import { ExperimentValidationService, type ExperimentDraft } from "../experiments/experiment-validation.js";
import { DEFAULT_EXPERIMENT_LIMITS } from "../experiments/experiment-config.js";

const validator = new ExperimentValidationService();

function draft(overrides: Partial<ExperimentDraft> = {}): ExperimentDraft {
  return {
    name: "Hook style test",
    hypothesis: "Pain-point hooks produce more saves than generic hooks.",
    variable: "hook",
    primaryMetric: "save_rate",
    variants: [
      { name: "control", role: "control", variableValue: "generic" },
      { name: "variant", role: "variant", variableValue: "pain_point" },
    ],
    ...overrides,
  };
}

function codes(issues: { code: string }[]) {
  return issues.map((i) => i.code);
}

describe("experiment validation — a valid design", () => {
  it("accepts a single-variable control/variant test and normalizes its config", () => {
    const result = validator.validate(draft());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    // Defaults are materialized so the experiment is judged by the rules it was
    // created with, not by whatever the config says later.
    expect(result.normalized).toMatchObject({
      variable: "hook",
      primaryMetric: "save_rate",
      minSamplesPerVariant: DEFAULT_EXPERIMENT_LIMITS.minSamplesPerVariant,
      minRelativeLift: DEFAULT_EXPERIMENT_LIMITS.minRelativeLift,
      maxDurationDays: DEFAULT_EXPERIMENT_LIMITS.maxDurationDays,
    });
  });
});

describe("experiment validation — design errors", () => {
  it("requires a hypothesis, because otherwise any result can be rationalized afterwards", () => {
    const result = validator.validate(draft({ hypothesis: "" }));
    expect(result.valid).toBe(false);
    expect(codes(result.errors)).toContain("HYPOTHESIS_REQUIRED");
  });

  it("rejects a variable the engine does not know how to apply", () => {
    const result = validator.validate(draft({ variable: "moon_phase" }));
    expect(result.valid).toBe(false);
    expect(codes(result.errors)).toContain("VARIABLE_UNSUPPORTED");
  });

  it("rejects a metric the analytics layer never produces", () => {
    const result = validator.validate(draft({ primaryMetric: "virality_score" }));
    expect(result.valid).toBe(false);
    expect(codes(result.errors)).toContain("METRIC_UNSUPPORTED");
  });

  it("rejects a secondary metric that does not exist", () => {
    const result = validator.validate(draft({ secondaryMetrics: ["reach", "vibes"] }));
    expect(result.valid).toBe(false);
    expect(codes(result.errors)).toContain("METRIC_UNSUPPORTED");
  });

  it("requires exactly one control", () => {
    const noControl = validator.validate(
      draft({
        variants: [
          { name: "a", role: "variant", variableValue: "x" },
          { name: "b", role: "variant", variableValue: "y" },
        ],
      }),
    );
    expect(codes(noControl.errors)).toContain("CONTROL_MISSING");

    const twoControls = validator.validate(
      draft({
        variants: [
          { name: "a", role: "control", variableValue: "x" },
          { name: "b", role: "control", variableValue: "y" },
        ],
      }),
    );
    expect(codes(twoControls.errors)).toContain("CONTROL_AMBIGUOUS");
  });

  it("rejects fewer than two arms", () => {
    const result = validator.validate(draft({ variants: [{ name: "only", role: "control", variableValue: "x" }] }));
    expect(codes(result.errors)).toContain("VARIANTS_INSUFFICIENT");
  });

  it("rejects duplicate arm names", () => {
    const result = validator.validate(
      draft({
        variants: [
          { name: "same", role: "control", variableValue: "a" },
          { name: "same", role: "variant", variableValue: "b" },
        ],
      }),
    );
    expect(codes(result.errors)).toContain("VARIANT_DUPLICATE");
  });

  it("rejects two arms holding the same value — there would be nothing to compare", () => {
    const result = validator.validate(
      draft({
        variants: [
          { name: "control", role: "control", variableValue: "generic" },
          { name: "variant", role: "variant", variableValue: "generic" },
        ],
      }),
    );
    expect(codes(result.errors)).toContain("VARIANT_VALUE_DUPLICATE");
  });

  it("rejects an experiment that could run forever", () => {
    expect(codes(validator.validate(draft({ maxDurationDays: 0 })).errors)).toContain("DURATION_INVALID");
    expect(codes(validator.validate(draft({ maxDurationDays: 9999 })).errors)).toContain("DURATION_TOO_LONG");
  });

  it("rejects a non-positive observation window", () => {
    expect(codes(validator.validate(draft({ observationWindowHours: 0 })).errors)).toContain("WINDOW_INVALID");
  });
});

describe("experiment validation — confounded designs", () => {
  it("blocks a design where the arms differ in several things at once", () => {
    // Different topic AND format AND cta: a result could not be attributed to
    // the hook, which is supposedly the variable under test.
    const result = validator.validate(
      draft({
        variants: [
          {
            name: "control",
            role: "control",
            variableValue: "generic",
            fixedDimensions: { topic: "debugging", format: "image", cta: "save" },
          },
          {
            name: "variant",
            role: "variant",
            variableValue: "pain_point",
            fixedDimensions: { topic: "tooling", format: "reel", cta: "follow" },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(codes(result.errors)).toContain("CONFOUNDED_DESIGN");
  });

  it("warns but allows a single incidental difference", () => {
    const result = validator.validate(
      draft({
        variants: [
          { name: "control", role: "control", variableValue: "generic", fixedDimensions: { topic: "debugging", format: "image" } },
          { name: "variant", role: "variant", variableValue: "pain_point", fixedDimensions: { topic: "tooling", format: "image" } },
        ],
      }),
    );

    expect(result.valid).toBe(true);
    expect(codes(result.warnings)).toContain("CONFOUNDED_DESIGN");
  });

  it("allows a deliberate multi-factor design, but still flags it", () => {
    const result = validator.validate(
      draft({
        variants: [
          { name: "control", role: "control", variableValue: "generic", fixedDimensions: { topic: "a", format: "image", cta: "save" } },
          { name: "variant", role: "variant", variableValue: "pain_point", fixedDimensions: { topic: "b", format: "reel", cta: "follow" } },
        ],
      }),
      { allowMultiFactor: true },
    );

    expect(result.valid).toBe(true);
    expect(codes(result.warnings)).toContain("CONFOUNDED_DESIGN");
  });

  it("does not treat the variable under test as a confounder", () => {
    const result = validator.validate(
      draft({
        variable: "format",
        variants: [
          { name: "control", role: "control", variableValue: "carousel", fixedDimensions: { format: "carousel", topic: "same" } },
          { name: "variant", role: "variant", variableValue: "reel", fixedDimensions: { format: "reel", topic: "same" } },
        ],
      }),
    );

    expect(result.valid).toBe(true);
    expect(codes(result.warnings)).not.toContain("CONFOUNDED_DESIGN");
  });
});

describe("experiment validation — concurrency", () => {
  it("rejects a second experiment on a variable already under test", () => {
    const result = validator.validate(draft(), { activeVariables: ["hook"], activeExperimentCount: 0 });
    expect(result.valid).toBe(false);
    expect(codes(result.errors)).toContain("VARIABLE_ALREADY_UNDER_TEST");
  });

  it("rejects exceeding the active experiment limit", () => {
    const result = validator.validate(draft(), { activeExperimentCount: 1 });
    expect(result.valid).toBe(false);
    expect(codes(result.errors)).toContain("TOO_MANY_ACTIVE_EXPERIMENTS");
  });

  it("allows concurrency when the limit is explicitly raised", () => {
    const result = validator.validate(draft(), {
      activeExperimentCount: 1,
      limits: { maxActiveExperimentsPerAccount: 3 },
    });
    expect(result.valid).toBe(true);
  });
});

describe("experiment validation — warnings that do not block", () => {
  it("warns when the sample size is below the configured minimum", () => {
    const result = validator.validate(draft({ minSamplesPerVariant: 2 }));
    expect(result.valid).toBe(true);
    expect(codes(result.warnings)).toContain("SAMPLE_SIZE_LOW");
  });

  it("warns when the primary metric is a raw count rather than a rate", () => {
    const result = validator.validate(draft({ primaryMetric: "likes" }));
    expect(result.valid).toBe(true);
    expect(codes(result.warnings)).toContain("METRIC_NOT_A_RATE");
  });

  it("still refuses a sample size below 1", () => {
    expect(codes(validator.validate(draft({ minSamplesPerVariant: 0 })).errors)).toContain("SAMPLE_SIZE_INVALID");
  });
});
