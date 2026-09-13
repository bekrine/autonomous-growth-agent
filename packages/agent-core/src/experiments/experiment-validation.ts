import {
  DEFAULT_EXPERIMENT_LIMITS,
  isExperimentMetric,
  isExperimentVariable,
  RATE_METRICS,
  type ExperimentLimits,
  type ExperimentVariable,
} from "./experiment-config.js";

/**
 * Deterministic gatekeeper between a proposal and a real experiment.
 *
 * The LLM may propose a hypothesis, a variable and candidate metrics. It does
 * not get to decide whether the design is sound: allowed variables, metric
 * existence, arm structure, sample rules and concurrency are all enforced here
 * in ordinary code. A model that confidently proposes a two-post experiment
 * with three simultaneous variables is rejected by the same rules as anything
 * else.
 */

export interface ExperimentVariantDraft {
  name: string;
  role: "control" | "variant";
  /** The value this arm holds for the experiment's variable, e.g. "reel". */
  variableValue: string;
  description?: string;
  /** Everything except the variable under test must match across arms — see checkConfounders. */
  fixedDimensions?: Record<string, string | null>;
}

export interface ExperimentDraft {
  name: string;
  hypothesis: string;
  variable: string;
  primaryMetric: string;
  secondaryMetrics?: string[];
  variants: ExperimentVariantDraft[];
  minSamplesPerVariant?: number;
  observationWindowHours?: number;
  maxDurationDays?: number;
  minRelativeLift?: number;
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  /** Design smells that do not block creation but weaken interpretation. */
  warnings: ValidationIssue[];
  normalized?: Required<
    Pick<ExperimentDraft, "name" | "hypothesis" | "primaryMetric" | "variants">
  > & {
    variable: ExperimentVariable;
    secondaryMetrics: string[];
    minSamplesPerVariant: number;
    observationWindowHours: number;
    maxDurationDays: number;
    minRelativeLift: number;
  };
}

export interface ValidationContext {
  /** Variables already under test by a running experiment on this account. */
  activeVariables?: string[];
  activeExperimentCount?: number;
  limits?: Partial<ExperimentLimits>;
  /** Set when the caller deliberately wants to vary more than one thing. */
  allowMultiFactor?: boolean;
}

export class ExperimentValidationService {
  constructor(private readonly defaults: ExperimentLimits = DEFAULT_EXPERIMENT_LIMITS) {}

  validate(draft: ExperimentDraft, context: ValidationContext = {}): ValidationResult {
    const limits: ExperimentLimits = { ...this.defaults, ...context.limits };
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    if (!draft.name?.trim()) {
      errors.push({ field: "name", code: "NAME_REQUIRED", message: "An experiment needs a name." });
    }

    // A hypothesis is not decoration: without a stated expectation, any result
    // can be rationalized after the fact.
    if (!draft.hypothesis?.trim()) {
      errors.push({
        field: "hypothesis",
        code: "HYPOTHESIS_REQUIRED",
        message: "An experiment needs a hypothesis stating what you expect and why.",
      });
    } else if (draft.hypothesis.trim().length < 15) {
      warnings.push({
        field: "hypothesis",
        code: "HYPOTHESIS_VAGUE",
        message: "The hypothesis is very short — it may be too vague to evaluate against.",
      });
    }

    if (!draft.variable || !isExperimentVariable(draft.variable)) {
      errors.push({
        field: "variable",
        code: "VARIABLE_UNSUPPORTED",
        message: `Variable must be one of the supported experiment variables. Received: ${draft.variable ?? "(none)"}.`,
      });
    }

    if (!draft.primaryMetric || !isExperimentMetric(draft.primaryMetric)) {
      errors.push({
        field: "primaryMetric",
        code: "METRIC_UNSUPPORTED",
        message: `Primary metric must be a metric the analytics layer produces. Received: ${draft.primaryMetric ?? "(none)"}.`,
      });
    } else if (!RATE_METRICS.has(draft.primaryMetric)) {
      warnings.push({
        field: "primaryMetric",
        code: "METRIC_NOT_A_RATE",
        message: `"${draft.primaryMetric}" is a raw count, so it is sensitive to how much distribution each post happened to get. A rate compares arms more fairly.`,
      });
    }

    for (const metric of draft.secondaryMetrics ?? []) {
      if (!isExperimentMetric(metric)) {
        errors.push({
          field: "secondaryMetrics",
          code: "METRIC_UNSUPPORTED",
          message: `Secondary metric "${metric}" is not produced by the analytics layer.`,
        });
      }
    }

    this.validateVariants(draft, errors, warnings, context);
    this.validateLimits(draft, limits, errors, warnings);
    this.validateConcurrency(draft, limits, context, errors);

    if (errors.length > 0) return { valid: false, errors, warnings };

    return {
      valid: true,
      errors,
      warnings,
      normalized: {
        name: draft.name.trim(),
        hypothesis: draft.hypothesis.trim(),
        variable: draft.variable as ExperimentVariable,
        primaryMetric: draft.primaryMetric,
        secondaryMetrics: draft.secondaryMetrics ?? [],
        variants: draft.variants,
        minSamplesPerVariant: draft.minSamplesPerVariant ?? limits.minSamplesPerVariant,
        observationWindowHours: draft.observationWindowHours ?? limits.observationWindowHours,
        maxDurationDays: draft.maxDurationDays ?? limits.maxDurationDays,
        minRelativeLift: draft.minRelativeLift ?? limits.minRelativeLift,
      },
    };
  }

  private validateVariants(
    draft: ExperimentDraft,
    errors: ValidationIssue[],
    warnings: ValidationIssue[],
    context: ValidationContext,
  ) {
    const variants = draft.variants ?? [];

    if (variants.length < 2) {
      errors.push({
        field: "variants",
        code: "VARIANTS_INSUFFICIENT",
        message: "An experiment needs a control and at least one variant.",
      });
      return;
    }

    const controls = variants.filter((v) => v.role === "control");
    if (controls.length === 0) {
      errors.push({ field: "variants", code: "CONTROL_MISSING", message: "Exactly one arm must be the control." });
    } else if (controls.length > 1) {
      errors.push({
        field: "variants",
        code: "CONTROL_AMBIGUOUS",
        message: "Only one arm may be the control; otherwise there is no baseline to compare against.",
      });
    }

    if (variants.filter((v) => v.role === "variant").length === 0) {
      errors.push({ field: "variants", code: "VARIANT_MISSING", message: "An experiment needs at least one variant arm." });
    }

    const names = new Set<string>();
    const values = new Set<string>();
    for (const variant of variants) {
      if (!variant.name?.trim()) {
        errors.push({ field: "variants", code: "VARIANT_NAME_REQUIRED", message: "Every arm needs a name." });
        continue;
      }
      const key = variant.name.trim().toLowerCase();
      if (names.has(key)) {
        errors.push({
          field: "variants",
          code: "VARIANT_DUPLICATE",
          message: `Duplicate arm name "${variant.name}".`,
        });
      }
      names.add(key);

      if (!variant.variableValue?.trim()) {
        errors.push({
          field: "variants",
          code: "VARIANT_VALUE_REQUIRED",
          message: `Arm "${variant.name}" must state its value for the experiment variable.`,
        });
        continue;
      }
      const valueKey = variant.variableValue.trim().toLowerCase();
      // Two arms holding the same value are not a comparison.
      if (values.has(valueKey)) {
        errors.push({
          field: "variants",
          code: "VARIANT_VALUE_DUPLICATE",
          message: `Two arms both use "${variant.variableValue}" — there is nothing to compare.`,
        });
      }
      values.add(valueKey);
    }

    this.checkConfounders(draft, warnings, errors, context);
  }

  /**
   * The heart of experiment validity: everything *except* the variable under
   * test should match across arms. If the arms differ in topic AND format AND
   * CTA, a difference in the result cannot be attributed to any one of them.
   */
  private checkConfounders(
    draft: ExperimentDraft,
    warnings: ValidationIssue[],
    errors: ValidationIssue[],
    context: ValidationContext,
  ) {
    const withDimensions = (draft.variants ?? []).filter((v) => v.fixedDimensions);
    if (withDimensions.length < 2) return;

    const [first, ...rest] = withDimensions;
    const differing: string[] = [];

    for (const [dimension, value] of Object.entries(first!.fixedDimensions ?? {})) {
      // The variable under test is *supposed* to differ.
      if (dimension === draft.variable) continue;
      if (rest.some((variant) => (variant.fixedDimensions ?? {})[dimension] !== value)) {
        differing.push(dimension);
      }
    }

    if (differing.length === 0) return;

    const issue: ValidationIssue = {
      field: "variants",
      code: "CONFOUNDED_DESIGN",
      message: `Arms differ in ${differing.join(", ")} as well as ${draft.variable}. A result could not be attributed to ${draft.variable} alone.`,
    };

    // One extra difference is a warning; several means the comparison is
    // meaningless unless the caller explicitly asked for a multi-factor test.
    if (context.allowMultiFactor) warnings.push(issue);
    else if (differing.length >= 2) errors.push(issue);
    else warnings.push(issue);
  }

  private validateLimits(
    draft: ExperimentDraft,
    limits: ExperimentLimits,
    errors: ValidationIssue[],
    warnings: ValidationIssue[],
  ) {
    const samples = draft.minSamplesPerVariant ?? limits.minSamplesPerVariant;
    if (samples < 1) {
      errors.push({
        field: "minSamplesPerVariant",
        code: "SAMPLE_SIZE_INVALID",
        message: "Minimum samples per variant must be at least 1.",
      });
    } else if (samples < limits.minSamplesPerVariant) {
      // Explicitly allowed but called out: this is the single easiest way to
      // fool yourself with an experiment.
      warnings.push({
        field: "minSamplesPerVariant",
        code: "SAMPLE_SIZE_LOW",
        message: `${samples} posts per arm is below the configured minimum of ${limits.minSamplesPerVariant}. Results will be directional only.`,
      });
    }

    const window = draft.observationWindowHours ?? limits.observationWindowHours;
    if (window <= 0) {
      errors.push({
        field: "observationWindowHours",
        code: "WINDOW_INVALID",
        message: "The observation window must be greater than zero hours.",
      });
    }

    const duration = draft.maxDurationDays ?? limits.maxDurationDays;
    if (duration <= 0) {
      errors.push({
        field: "maxDurationDays",
        code: "DURATION_INVALID",
        message: "Maximum duration must be greater than zero days. An experiment must not run forever.",
      });
    } else if (duration > limits.maxDurationDays) {
      errors.push({
        field: "maxDurationDays",
        code: "DURATION_TOO_LONG",
        message: `Maximum duration may not exceed the configured ceiling of ${limits.maxDurationDays} days.`,
      });
    }

    const lift = draft.minRelativeLift ?? limits.minRelativeLift;
    if (lift < 0) {
      errors.push({
        field: "minRelativeLift",
        code: "LIFT_INVALID",
        message: "Minimum relative lift cannot be negative.",
      });
    }
  }

  private validateConcurrency(
    draft: ExperimentDraft,
    limits: ExperimentLimits,
    context: ValidationContext,
    errors: ValidationIssue[],
  ) {
    // Conservative default: one active experiment per account and variable.
    // Two experiments varying the same thing at once make both uninterpretable.
    if (draft.variable && (context.activeVariables ?? []).includes(draft.variable)) {
      errors.push({
        field: "variable",
        code: "VARIABLE_ALREADY_UNDER_TEST",
        message: `Another running experiment is already varying "${draft.variable}" for this account. Finish or cancel it first.`,
      });
    }

    const active = context.activeExperimentCount ?? 0;
    if (active >= limits.maxActiveExperimentsPerAccount) {
      errors.push({
        field: "status",
        code: "TOO_MANY_ACTIVE_EXPERIMENTS",
        message: `This account already has ${active} active experiment(s); the configured limit is ${limits.maxActiveExperimentsPerAccount}. Concurrent experiments make results harder to attribute.`,
      });
    }
  }
}
