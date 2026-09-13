/**
 * What a learning run is allowed to change, and by how much.
 *
 * The split between strategic and protected fields is the core safety
 * property of Phase 7: the agent may tune *what to post*, and may never touch
 * credentials, policies, permissions, the kill switch or approval
 * requirements. That is enforced by an allowlist, not a denylist — an
 * unrecognised field is refused rather than permitted by omission.
 */

/** The only fields a learning run may propose changes to. */
export const MUTABLE_STRATEGY_FIELDS = [
  "formats",
  "contentPillars",
  "postingFrequencyPerWeek",
  "audience",
  "positioning",
] as const;

export type MutableStrategyField = (typeof MUTABLE_STRATEGY_FIELDS)[number];

/**
 * Explicitly named so a refusal can say *why*. Anything not in
 * MUTABLE_STRATEGY_FIELDS is refused regardless; this list exists to give a
 * precise message for the cases that matter most.
 */
export const PROTECTED_FIELDS = [
  "credentials",
  "accessToken",
  "tokens",
  "policies",
  "policy",
  "permissions",
  "killSwitch",
  "autonomyKillSwitch",
  "safety",
  "safetyConfiguration",
  "contentSafety",
  "humanApproval",
  "contentApprovalRequired",
  "financialLimits",
  "budget",
  "spend",
  "ownership",
  "accountId",
  "socialAccountId",
] as const;

export interface StrategyLimits {
  /** Largest allowed move for a single weight, in absolute terms (0.20 = 20 points). */
  maxSingleChange: number;
  /** Largest allowed move for a content pillar weight. */
  maxPillarChange: number;
  /** Largest allowed change to posts per week. */
  maxPostingFrequencyChange: number;
  /** Days a strategy must hold before another change is permitted. */
  minHoldDays: number;
  /** Dimensions that may change in one cycle — keeps results interpretable. */
  maxDimensionsPerCycle: number;
  postingFrequencyMin: number;
  postingFrequencyMax: number;
}

export const DEFAULT_STRATEGY_LIMITS: StrategyLimits = {
  maxSingleChange: 0.2,
  maxPillarChange: 0.25,
  maxPostingFrequencyChange: 1,
  minHoldDays: 3,
  maxDimensionsPerCycle: 2,
  postingFrequencyMin: 1,
  postingFrequencyMax: 21,
};

export interface StrategyContent {
  audience?: string;
  positioning?: string;
  contentPillars?: { name: string; weight: number }[];
  formats?: Record<string, number>;
  postingFrequencyPerWeek?: number;
  [key: string]: unknown;
}

export interface GuardrailIssue {
  field: string;
  code: string;
  message: string;
}

export function isProtectedField(field: string): boolean {
  const normalized = field.toLowerCase();
  return PROTECTED_FIELDS.some((protectedField) => normalized === protectedField.toLowerCase());
}

export function isMutableField(field: string): boolean {
  return (MUTABLE_STRATEGY_FIELDS as readonly string[]).includes(field);
}

/**
 * Structural validation of a proposed strategy body.
 *
 * Weights are normalized rather than required to sum to exactly 1: the
 * StrategyAgent's own prompt states they are a relative mix, so demanding an
 * exact total would reject strategies the system itself produces. What is
 * rejected is genuinely invalid — negatives, values above 1, empty sets,
 * non-finite numbers.
 */
export function validateStrategyContent(content: StrategyContent, limits: StrategyLimits): GuardrailIssue[] {
  const issues: GuardrailIssue[] = [];

  for (const key of Object.keys(content)) {
    if (isProtectedField(key)) {
      issues.push({
        field: key,
        code: "PROTECTED_FIELD",
        message: `"${key}" is a protected system field and can never be changed by a learning run.`,
      });
    }
  }

  if (content.formats !== undefined) {
    const entries = Object.entries(content.formats);
    if (entries.length === 0) {
      issues.push({ field: "formats", code: "FORMATS_EMPTY", message: "Format allocation cannot be empty." });
    }
    for (const [format, weight] of entries) {
      if (typeof weight !== "number" || !Number.isFinite(weight)) {
        issues.push({ field: `formats.${format}`, code: "WEIGHT_INVALID", message: `Weight for "${format}" is not a number.` });
      } else if (weight < 0) {
        issues.push({ field: `formats.${format}`, code: "WEIGHT_NEGATIVE", message: `Weight for "${format}" cannot be negative.` });
      } else if (weight > 1) {
        issues.push({ field: `formats.${format}`, code: "WEIGHT_ABOVE_ONE", message: `Weight for "${format}" cannot exceed 1.` });
      }
    }
  }

  if (content.contentPillars !== undefined) {
    if (!Array.isArray(content.contentPillars) || content.contentPillars.length === 0) {
      issues.push({ field: "contentPillars", code: "PILLARS_EMPTY", message: "Content pillars cannot be empty." });
    } else {
      for (const pillar of content.contentPillars) {
        if (!pillar?.name?.trim()) {
          issues.push({ field: "contentPillars", code: "PILLAR_NAME_REQUIRED", message: "Every content pillar needs a name." });
        }
        if (typeof pillar?.weight !== "number" || !Number.isFinite(pillar.weight) || pillar.weight < 0 || pillar.weight > 1) {
          issues.push({
            field: `contentPillars.${pillar?.name ?? "?"}`,
            code: "WEIGHT_INVALID",
            message: `Weight for pillar "${pillar?.name ?? "?"}" must be between 0 and 1.`,
          });
        }
      }
    }
  }

  if (content.postingFrequencyPerWeek !== undefined) {
    const frequency = content.postingFrequencyPerWeek;
    if (typeof frequency !== "number" || !Number.isFinite(frequency) || frequency < limits.postingFrequencyMin) {
      issues.push({
        field: "postingFrequencyPerWeek",
        code: "FREQUENCY_INVALID",
        message: `Posting frequency must be at least ${limits.postingFrequencyMin} per week.`,
      });
    } else if (frequency > limits.postingFrequencyMax) {
      issues.push({
        field: "postingFrequencyPerWeek",
        code: "FREQUENCY_TOO_HIGH",
        message: `Posting frequency may not exceed ${limits.postingFrequencyMax} per week.`,
      });
    }
  }

  return issues;
}

/** Scales weights to sum to 1 while preserving their relative proportions. */
export function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return weights;
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Number((value / total).toFixed(4))]));
}

/**
 * Rebalances to a total of 1 while holding the just-changed weights EXACTLY
 * where the evaluator put them; the untouched weights absorb the difference
 * proportionally.
 *
 * Plain normalization would silently dilute an approved change — raising reel
 * 0.40 -> 0.45 alongside unchanged 0.35/0.25 sums to 1.05, and rescaling drops
 * reel back to 0.4286. The approved move must survive the bookkeeping, or the
 * guardrails are deciding the value rather than bounding it.
 */
export function rebalanceWeights(weights: Record<string, number>, lockedKeys: string[]): Record<string, number> {
  const locked = new Set(lockedKeys);
  const lockedTotal = Object.entries(weights)
    .filter(([key]) => locked.has(key))
    .reduce((sum, [, value]) => sum + value, 0);
  const freeEntries = Object.entries(weights).filter(([key]) => !locked.has(key));
  const freeTotal = freeEntries.reduce((sum, [, value]) => sum + value, 0);

  // Nothing left to absorb the difference, or the locked values already fill
  // the budget: fall back to proportional normalization over everything.
  const remaining = 1 - lockedTotal;
  if (freeEntries.length === 0 || freeTotal <= 0 || remaining <= 0) return normalizeWeights(weights);

  const scale = remaining / freeTotal;
  return Object.fromEntries(
    Object.entries(weights).map(([key, value]) => [
      key,
      Number((locked.has(key) ? value : value * scale).toFixed(4)),
    ]),
  );
}

export interface StrategyDiffEntry {
  field: string;
  target: string;
  previous: number | string | undefined;
  next: number | string | undefined;
  delta?: number;
}

/**
 * Deterministic diff between two strategy bodies. Used for the change summary,
 * for the dashboard, and for enforcing the per-cycle dimension limit.
 */
export function diffStrategies(previous: StrategyContent, next: StrategyContent): StrategyDiffEntry[] {
  const entries: StrategyDiffEntry[] = [];

  const previousFormats = previous.formats ?? {};
  const nextFormats = next.formats ?? {};
  for (const format of new Set([...Object.keys(previousFormats), ...Object.keys(nextFormats)])) {
    const before = previousFormats[format];
    const after = nextFormats[format];
    if (before === after) continue;
    entries.push({
      field: "formats",
      target: format,
      previous: before,
      next: after,
      delta: (after ?? 0) - (before ?? 0),
    });
  }

  const previousPillars = new Map((previous.contentPillars ?? []).map((p) => [p.name, p.weight]));
  const nextPillars = new Map((next.contentPillars ?? []).map((p) => [p.name, p.weight]));
  for (const name of new Set([...previousPillars.keys(), ...nextPillars.keys()])) {
    const before = previousPillars.get(name);
    const after = nextPillars.get(name);
    if (before === after) continue;
    entries.push({ field: "contentPillars", target: name, previous: before, next: after, delta: (after ?? 0) - (before ?? 0) });
  }

  if (previous.postingFrequencyPerWeek !== next.postingFrequencyPerWeek) {
    entries.push({
      field: "postingFrequencyPerWeek",
      target: "postingFrequencyPerWeek",
      previous: previous.postingFrequencyPerWeek,
      next: next.postingFrequencyPerWeek,
      delta: (next.postingFrequencyPerWeek ?? 0) - (previous.postingFrequencyPerWeek ?? 0),
    });
  }

  for (const field of ["audience", "positioning"] as const) {
    if (previous[field] !== next[field]) {
      entries.push({ field, target: field, previous: previous[field], next: next[field] });
    }
  }

  return entries;
}

/** Human-readable one-liner, stored on the strategy version. */
export function describeDiff(entries: StrategyDiffEntry[]): string {
  if (entries.length === 0) return "No changes.";
  return entries
    .map((entry) => {
      const before = typeof entry.previous === "number" ? entry.previous.toFixed(2) : (entry.previous ?? "unset");
      const after = typeof entry.next === "number" ? entry.next.toFixed(2) : (entry.next ?? "unset");
      return `${entry.target} ${before} → ${after}`;
    })
    .join("; ");
}
