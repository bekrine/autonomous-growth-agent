import type { EvidenceStrength } from "./evidence-evaluator.js";
import {
  DEFAULT_STRATEGY_LIMITS,
  describeDiff,
  diffStrategies,
  isMutableField,
  isProtectedField,
  rebalanceWeights,
  validateStrategyContent,
  type GuardrailIssue,
  type StrategyContent,
  type StrategyDiffEntry,
  type StrategyLimits,
} from "./strategy-guardrails.js";

/**
 * Decides whether a proposed strategy change may actually be applied.
 *
 * This is the authority in Phase 7. The LearningAgent proposes; this service
 * accepts, trims or rejects. Everything it enforces is deterministic, so the
 * same proposal against the same state always produces the same verdict — and
 * a rejection always names the rule that fired.
 *
 * It does not write to the database. It returns a decision; LearningService
 * persists it.
 */

export interface ProposedChange {
  changeType: string;
  target: string;
  currentValue: unknown;
  proposedValue: unknown;
  reason: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
}

export interface ChangeVerdict {
  change: ProposedChange;
  accepted: boolean;
  /** Applied value after clamping, when a change was accepted but trimmed. */
  appliedValue?: number | string;
  clamped?: boolean;
  code?: string;
  reason?: string;
}

export interface StrategyEvaluationInput {
  currentContent: StrategyContent;
  changes: ProposedChange[];
  evidenceStrength: EvidenceStrength;
  /** When the current strategy version was created — drives the cooling period. */
  currentVersionCreatedAt: Date | null;
  limits?: Partial<StrategyLimits>;
  now?: Date;
}

export interface StrategyEvaluationResult {
  /** True only when at least one change survived every rule. */
  applicable: boolean;
  verdicts: ChangeVerdict[];
  /** The strategy body to persist, when applicable. */
  nextContent?: StrategyContent;
  diff: StrategyDiffEntry[];
  changeSummary: string;
  /** Structural problems with the resulting strategy. */
  issues: GuardrailIssue[];
  /** Why nothing was applied, when nothing was. */
  blockedReason?: string;
  limits: StrategyLimits;
}

/** Evidence strength required before a change of a given size is permitted. */
const STRENGTH_RANK: Record<EvidenceStrength, number> = {
  insufficient: 0,
  early_signal: 1,
  moderate: 2,
  strong: 3,
};

/**
 * How large a weight move each evidence level permits. Early signals may nudge;
 * only strong evidence may make the full allowed move. This is what keeps the
 * agent from swinging a 40% allocation to 100% off one good week.
 */
const MAX_CHANGE_BY_STRENGTH: Record<EvidenceStrength, number> = {
  insufficient: 0,
  early_signal: 0.05,
  moderate: 0.1,
  strong: 1, // full limit — still capped by StrategyLimits.maxSingleChange
};

export class StrategyEvaluationService {
  constructor(private readonly defaults: StrategyLimits = DEFAULT_STRATEGY_LIMITS) {}

  evaluate(input: StrategyEvaluationInput): StrategyEvaluationResult {
    const limits: StrategyLimits = { ...this.defaults, ...input.limits };
    const now = input.now ?? new Date();
    const verdicts: ChangeVerdict[] = [];

    // Rule 1 — nothing may change without at least an early signal.
    if (STRENGTH_RANK[input.evidenceStrength] < STRENGTH_RANK.early_signal) {
      return {
        applicable: false,
        verdicts: input.changes.map((change) => ({
          change,
          accepted: false,
          code: "INSUFFICIENT_EVIDENCE",
          reason: "There is not enough measured data to justify any strategy change.",
        })),
        diff: [],
        changeSummary: "No changes.",
        issues: [],
        blockedReason: "Insufficient evidence — no strategy change is permitted.",
        limits,
      };
    }

    // Rule 2 — cooling period. Changing again immediately means the previous
    // change never had time to produce the observations that would judge it.
    const holdMs = limits.minHoldDays * 24 * 60 * 60_000;
    if (input.currentVersionCreatedAt && now.getTime() - input.currentVersionCreatedAt.getTime() < holdMs) {
      const daysRemaining = Math.ceil(
        (holdMs - (now.getTime() - input.currentVersionCreatedAt.getTime())) / (24 * 60 * 60_000),
      );
      return {
        applicable: false,
        verdicts: input.changes.map((change) => ({
          change,
          accepted: false,
          code: "COOLING_PERIOD",
          reason: `The current strategy must hold for ${limits.minHoldDays} day(s); ${daysRemaining} remaining.`,
        })),
        diff: [],
        changeSummary: "No changes.",
        issues: [],
        blockedReason: `Cooling period active — ${daysRemaining} day(s) remaining before another change is allowed.`,
        limits,
      };
    }

    // Rule 3 — per-change validation, applied in order so the dimension cap
    // counts only changes that were otherwise acceptable.
    const next: StrategyContent = structuredClone(input.currentContent);
    const touchedDimensions = new Set<string>();

    for (const change of input.changes) {
      const verdict = this.evaluateChange(change, next, input.evidenceStrength, limits, touchedDimensions);
      verdicts.push(verdict);
      if (verdict.accepted) {
        this.applyChange(next, change, verdict.appliedValue!);
        touchedDimensions.add(this.dimensionOf(change));
      }
    }

    const accepted = verdicts.filter((v) => v.accepted);
    if (accepted.length === 0) {
      return {
        applicable: false,
        verdicts,
        diff: [],
        changeSummary: "No changes.",
        issues: [],
        blockedReason: verdicts[0]?.reason ?? "No proposed change passed validation.",
        limits,
      };
    }

    // Rebalance to a total of 1, holding the approved values exactly and
    // letting the untouched weights absorb the difference. Plain normalization
    // would dilute the very change that was just approved.
    const changedFormats = accepted.filter((v) => this.fieldOf(v.change) === "formats").map((v) => v.change.target);
    const changedPillars = accepted.filter((v) => this.fieldOf(v.change) === "contentPillars").map((v) => v.change.target);

    if (next.formats) next.formats = rebalanceWeights(next.formats, changedFormats);
    if (next.contentPillars) {
      const rebalanced = rebalanceWeights(
        Object.fromEntries(next.contentPillars.map((p) => [p.name, p.weight])),
        changedPillars,
      );
      next.contentPillars = next.contentPillars.map((p) => ({ ...p, weight: rebalanced[p.name] ?? p.weight }));
    }

    const issues = validateStrategyContent(next, limits);
    if (issues.length > 0) {
      return {
        applicable: false,
        verdicts,
        diff: [],
        changeSummary: "No changes.",
        issues,
        blockedReason: `The resulting strategy would be invalid: ${issues[0]!.message}`,
        limits,
      };
    }

    const diff = diffStrategies(input.currentContent, next);
    return {
      applicable: diff.length > 0,
      verdicts,
      nextContent: next,
      diff,
      changeSummary: describeDiff(diff),
      issues: [],
      blockedReason: diff.length === 0 ? "The proposal produced no actual change." : undefined,
      limits,
    };
  }

  private evaluateChange(
    change: ProposedChange,
    current: StrategyContent,
    strength: EvidenceStrength,
    limits: StrategyLimits,
    touchedDimensions: Set<string>,
  ): ChangeVerdict {
    // Protected fields are refused by name, so the message is precise.
    if (isProtectedField(change.target) || isProtectedField(change.changeType)) {
      return {
        change,
        accepted: false,
        code: "PROTECTED_FIELD",
        reason: `"${change.target}" is a protected system field and can never be changed by a learning run.`,
      };
    }

    const field = this.fieldOf(change);
    // Allowlist, not denylist: an unrecognised field is refused rather than
    // permitted by omission.
    if (!isMutableField(field)) {
      return {
        change,
        accepted: false,
        code: "FIELD_NOT_MUTABLE",
        reason: `Learning runs may only change ${["formats", "contentPillars", "postingFrequencyPerWeek", "audience", "positioning"].join(", ")}.`,
      };
    }

    const dimension = this.dimensionOf(change);
    if (!touchedDimensions.has(dimension) && touchedDimensions.size >= limits.maxDimensionsPerCycle) {
      return {
        change,
        accepted: false,
        code: "TOO_MANY_DIMENSIONS",
        reason: `At most ${limits.maxDimensionsPerCycle} strategy dimension(s) may change per cycle, so results stay interpretable.`,
      };
    }

    if (field === "audience" || field === "positioning") {
      // Free text: allowed, but only on strong evidence — repositioning an
      // account is not a tweak.
      if (STRENGTH_RANK[strength] < STRENGTH_RANK.strong) {
        return {
          change,
          accepted: false,
          code: "EVIDENCE_TOO_WEAK",
          reason: `Changing ${field} requires strong evidence; this run is "${strength}".`,
        };
      }
      const value = String(change.proposedValue ?? "").trim();
      if (!value) {
        return { change, accepted: false, code: "VALUE_INVALID", reason: `${field} cannot be empty.` };
      }
      return { change, accepted: true, appliedValue: value };
    }

    const proposed = Number(change.proposedValue);
    if (!Number.isFinite(proposed)) {
      return { change, accepted: false, code: "VALUE_INVALID", reason: "The proposed value is not a number." };
    }

    const actualCurrent = this.currentValueOf(current, change);
    if (actualCurrent === undefined) {
      return {
        change,
        accepted: false,
        code: "TARGET_UNKNOWN",
        reason: `"${change.target}" is not part of the current strategy, so there is nothing to change.`,
      };
    }

    if (field === "postingFrequencyPerWeek") {
      const maxDelta = limits.maxPostingFrequencyChange;
      const clampedValue = clamp(
        proposed,
        actualCurrent - maxDelta,
        actualCurrent + maxDelta,
        limits.postingFrequencyMin,
        limits.postingFrequencyMax,
      );
      return {
        change,
        accepted: clampedValue !== actualCurrent,
        appliedValue: clampedValue,
        clamped: clampedValue !== proposed,
        code: clampedValue === actualCurrent ? "NO_EFFECT" : undefined,
        reason:
          clampedValue === actualCurrent
            ? "The proposed frequency is already in effect, or was clamped to it."
            : clampedValue !== proposed
              ? `Clamped to ±${maxDelta} post(s) per week.`
              : undefined,
      };
    }

    // Weight change (formats / contentPillars).
    const maxForField = field === "contentPillars" ? limits.maxPillarChange : limits.maxSingleChange;
    // Evidence strength caps the move further than the hard limit does.
    const maxForStrength = MAX_CHANGE_BY_STRENGTH[strength];
    const maxDelta = Math.min(maxForField, maxForStrength);

    const clampedValue = clamp(proposed, actualCurrent - maxDelta, actualCurrent + maxDelta, 0, 1);
    const rounded = Number(clampedValue.toFixed(4));

    if (rounded === Number(actualCurrent.toFixed(4))) {
      return {
        change,
        accepted: false,
        code: "NO_EFFECT",
        reason:
          maxForStrength === 0
            ? "Evidence is too weak to permit any movement."
            : `Clamped to the ±${maxDelta.toFixed(2)} allowed by "${strength}" evidence, which left the value unchanged.`,
      };
    }

    return {
      change,
      accepted: true,
      appliedValue: rounded,
      clamped: Math.abs(proposed - rounded) > 1e-6,
      reason:
        Math.abs(proposed - rounded) > 1e-6
          ? `Clamped from ${proposed.toFixed(2)} to ${rounded.toFixed(2)} — "${strength}" evidence allows at most ±${maxDelta.toFixed(2)}.`
          : undefined,
    };
  }

  private fieldOf(change: ProposedChange): string {
    const type = change.changeType.toLowerCase();
    if (type.includes("format")) return "formats";
    if (type.includes("pillar") || type.includes("topic")) return "contentPillars";
    if (type.includes("frequency") || type.includes("cadence")) return "postingFrequencyPerWeek";
    if (type.includes("audience")) return "audience";
    if (type.includes("positioning")) return "positioning";
    // Fall back to the target when the change type is unhelpful.
    return isMutableField(change.target) ? change.target : change.changeType;
  }

  /** Distinct "dimension" for the per-cycle cap — all format weights count as one. */
  private dimensionOf(change: ProposedChange): string {
    return this.fieldOf(change);
  }

  private currentValueOf(content: StrategyContent, change: ProposedChange): number | undefined {
    const field = this.fieldOf(change);
    if (field === "formats") return content.formats?.[change.target];
    if (field === "contentPillars") return content.contentPillars?.find((p) => p.name === change.target)?.weight;
    if (field === "postingFrequencyPerWeek") return content.postingFrequencyPerWeek;
    return undefined;
  }

  private applyChange(content: StrategyContent, change: ProposedChange, value: number | string): void {
    const field = this.fieldOf(change);
    if (field === "formats" && content.formats) {
      content.formats[change.target] = Number(value);
    } else if (field === "contentPillars" && content.contentPillars) {
      const pillar = content.contentPillars.find((p) => p.name === change.target);
      if (pillar) pillar.weight = Number(value);
    } else if (field === "postingFrequencyPerWeek") {
      content.postingFrequencyPerWeek = Number(value);
    } else if (field === "audience") {
      content.audience = String(value);
    } else if (field === "positioning") {
      content.positioning = String(value);
    }
  }
}

function clamp(value: number, min: number, max: number, absoluteMin: number, absoluteMax: number): number {
  return Math.min(Math.max(value, Math.max(min, absoluteMin)), Math.min(max, absoluteMax));
}
