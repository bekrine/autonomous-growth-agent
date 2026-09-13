import { describe, expect, it } from "vitest";
import {
  StrategyEvaluationService,
  type ProposedChange,
} from "../learning/strategy-evaluation-service.js";
import {
  DEFAULT_STRATEGY_LIMITS,
  describeDiff,
  diffStrategies,
  normalizeWeights,
  validateStrategyContent,
  type StrategyContent,
} from "../learning/strategy-guardrails.js";

const service = new StrategyEvaluationService();

function strategy(overrides: Partial<StrategyContent> = {}): StrategyContent {
  return {
    audience: "junior developers",
    positioning: "practical AI tooling",
    formats: { reel: 0.4, carousel: 0.35, image: 0.25 },
    contentPillars: [
      { name: "debugging", weight: 0.3 },
      { name: "tooling", weight: 0.4 },
      { name: "workflow", weight: 0.3 },
    ],
    postingFrequencyPerWeek: 4,
    ...overrides,
  };
}

function change(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    changeType: "format_allocation",
    target: "reel",
    currentValue: 0.4,
    proposedValue: 0.5,
    reason: "Reels outperformed the baseline",
    evidence: ["12 posts", "1.9x reach"],
    confidence: "high",
    ...overrides,
  };
}

/** Old enough that the cooling period never interferes. */
const LONG_AGO = new Date(Date.now() - 30 * 24 * 60 * 60_000);

function evaluate(changes: ProposedChange[], overrides: Partial<Parameters<typeof service.evaluate>[0]> = {}) {
  return service.evaluate({
    currentContent: strategy(),
    changes,
    evidenceStrength: "strong",
    currentVersionCreatedAt: LONG_AGO,
    ...overrides,
  });
}

describe("evidence gates the size of a change", () => {
  it("refuses any change on insufficient evidence", () => {
    const result = evaluate([change()], { evidenceStrength: "insufficient" });

    expect(result.applicable).toBe(false);
    expect(result.verdicts[0]!.code).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.nextContent).toBeUndefined();
  });

  it("allows only a nudge on an early signal", () => {
    // Asked for +0.15; an early signal permits at most +0.05.
    const result = evaluate([change({ proposedValue: 0.55 })], { evidenceStrength: "early_signal" });

    expect(result.applicable).toBe(true);
    expect(result.verdicts[0]!.clamped).toBe(true);
    // The approved value survives rebalancing exactly; the other formats absorb
    // the difference rather than diluting the change back out.
    expect(result.nextContent!.formats!.reel).toBeCloseTo(0.45, 4);
    expect(Object.values(result.nextContent!.formats!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(result.verdicts[0]!.reason).toContain("early_signal");
  });

  it("allows a larger but still bounded change on strong evidence", () => {
    // Asked for 0.40 -> 0.95; the hard limit caps the move at +0.20.
    const result = evaluate([change({ proposedValue: 0.95 })], { evidenceStrength: "strong" });

    expect(result.applicable).toBe(true);
    const applied = result.verdicts[0]!.appliedValue as number;
    expect(applied).toBeCloseTo(0.6, 4);
    expect(applied).toBeLessThan(0.95);
    expect(result.verdicts[0]!.clamped).toBe(true);
  });

  it("never lets a single change exceed the configured maximum", () => {
    for (const strength of ["early_signal", "moderate", "strong"] as const) {
      const result = evaluate([change({ proposedValue: 1 })], { evidenceStrength: strength });
      const applied = (result.verdicts[0]!.appliedValue as number) ?? 0.4;
      expect(applied - 0.4).toBeLessThanOrEqual(DEFAULT_STRATEGY_LIMITS.maxSingleChange + 1e-6);
    }
  });
});

describe("protected fields", () => {
  it("refuses to touch the kill switch", () => {
    const result = evaluate([change({ changeType: "killSwitch", target: "killSwitch", proposedValue: false })]);

    expect(result.applicable).toBe(false);
    expect(result.verdicts[0]!.code).toBe("PROTECTED_FIELD");
  });

  it("refuses credentials, permissions and approval requirements", () => {
    for (const target of ["credentials", "accessToken", "permissions", "contentApprovalRequired", "budget"]) {
      const result = evaluate([change({ changeType: target, target, proposedValue: "anything" })]);
      expect(result.verdicts[0]!.code).toBe("PROTECTED_FIELD");
      expect(result.applicable).toBe(false);
    }
  });

  it("refuses an unrecognised field rather than allowing it by omission", () => {
    // Allowlist, not denylist: something nobody anticipated is still refused.
    const result = evaluate([change({ changeType: "shadowban_evasion", target: "somethingNew", proposedValue: 1 })]);

    expect(result.verdicts[0]!.code).toBe("FIELD_NOT_MUTABLE");
    expect(result.applicable).toBe(false);
  });
});

describe("cooling period", () => {
  it("blocks a second change while the current strategy is still young", () => {
    const result = evaluate([change()], { currentVersionCreatedAt: new Date(Date.now() - 24 * 60 * 60_000) });

    expect(result.applicable).toBe(false);
    expect(result.verdicts[0]!.code).toBe("COOLING_PERIOD");
    expect(result.blockedReason).toContain("day(s) remaining");
  });

  it("allows a change once the hold period has elapsed", () => {
    const past = new Date(Date.now() - (DEFAULT_STRATEGY_LIMITS.minHoldDays + 1) * 24 * 60 * 60_000);
    expect(evaluate([change()], { currentVersionCreatedAt: past }).applicable).toBe(true);
  });

  it("allows the very first change when there is no previous version", () => {
    expect(evaluate([change()], { currentVersionCreatedAt: null }).applicable).toBe(true);
  });
});

describe("bounded scope per cycle", () => {
  it("limits how many dimensions may move at once", () => {
    const result = evaluate([
      change({ changeType: "format_allocation", target: "reel", proposedValue: 0.5 }),
      change({ changeType: "content_pillar", target: "debugging", proposedValue: 0.4 }),
      change({ changeType: "posting_frequency", target: "postingFrequencyPerWeek", proposedValue: 5 }),
    ]);

    // Two dimensions accepted, the third refused — results stay interpretable.
    expect(result.verdicts.filter((v) => v.accepted)).toHaveLength(2);
    expect(result.verdicts[2]!.code).toBe("TOO_MANY_DIMENSIONS");
  });

  it("treats several format weights as a single dimension", () => {
    const result = evaluate([
      change({ target: "reel", proposedValue: 0.5 }),
      change({ target: "carousel", proposedValue: 0.28 }),
      change({ target: "image", proposedValue: 0.22 }),
    ]);

    // All three are "formats", so none is refused for the dimension cap.
    expect(result.verdicts.every((v) => v.code !== "TOO_MANY_DIMENSIONS")).toBe(true);
  });

  it("clamps posting frequency to the allowed step", () => {
    const result = evaluate([
      change({ changeType: "posting_frequency", target: "postingFrequencyPerWeek", proposedValue: 14 }),
    ]);

    expect(result.nextContent!.postingFrequencyPerWeek).toBe(4 + DEFAULT_STRATEGY_LIMITS.maxPostingFrequencyChange);
  });
});

describe("repositioning requires strong evidence", () => {
  it("refuses an audience change on moderate evidence", () => {
    const result = evaluate([change({ changeType: "audience", target: "audience", proposedValue: "senior engineers" })], {
      evidenceStrength: "moderate",
    });

    expect(result.verdicts[0]!.code).toBe("EVIDENCE_TOO_WEAK");
  });

  it("allows it on strong evidence", () => {
    const result = evaluate([change({ changeType: "audience", target: "audience", proposedValue: "senior engineers" })], {
      evidenceStrength: "strong",
    });

    expect(result.applicable).toBe(true);
    expect(result.nextContent!.audience).toBe("senior engineers");
  });
});

describe("resulting strategy stays valid", () => {
  it("rebalances to a total of 1 without diluting the approved change", () => {
    const result = evaluate([change({ proposedValue: 0.55 })]);

    expect(result.nextContent!.formats!.reel).toBeCloseTo(0.55, 4);
    expect(Object.values(result.nextContent!.formats!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    // The untouched formats shrink proportionally, keeping their ratio.
    const { carousel, image } = result.nextContent!.formats!;
    expect(carousel / image).toBeCloseTo(0.35 / 0.25, 2);
  });

  it("refuses a target that is not part of the current strategy", () => {
    const result = evaluate([change({ target: "livestream", proposedValue: 0.3 })]);
    expect(result.verdicts[0]!.code).toBe("TARGET_UNKNOWN");
  });

  it("reports no-op proposals rather than creating an empty version", () => {
    const result = evaluate([change({ proposedValue: 0.4 })]);
    expect(result.applicable).toBe(false);
    expect(result.verdicts[0]!.code).toBe("NO_EFFECT");
  });
});

describe("guardrail validation", () => {
  it("rejects negative and out-of-range weights", () => {
    const codes = validateStrategyContent(
      strategy({ formats: { reel: -0.2, carousel: 1.5 } }),
      DEFAULT_STRATEGY_LIMITS,
    ).map((i) => i.code);

    expect(codes).toContain("WEIGHT_NEGATIVE");
    expect(codes).toContain("WEIGHT_ABOVE_ONE");
  });

  it("rejects empty format and pillar sets", () => {
    expect(validateStrategyContent(strategy({ formats: {} }), DEFAULT_STRATEGY_LIMITS).map((i) => i.code)).toContain(
      "FORMATS_EMPTY",
    );
    expect(
      validateStrategyContent(strategy({ contentPillars: [] }), DEFAULT_STRATEGY_LIMITS).map((i) => i.code),
    ).toContain("PILLARS_EMPTY");
  });

  it("rejects an impossible posting frequency", () => {
    expect(
      validateStrategyContent(strategy({ postingFrequencyPerWeek: 0 }), DEFAULT_STRATEGY_LIMITS).map((i) => i.code),
    ).toContain("FREQUENCY_INVALID");
    expect(
      validateStrategyContent(strategy({ postingFrequencyPerWeek: 50 }), DEFAULT_STRATEGY_LIMITS).map((i) => i.code),
    ).toContain("FREQUENCY_TOO_HIGH");
  });

  it("flags a protected field appearing in the strategy body itself", () => {
    const issues = validateStrategyContent({ ...strategy(), killSwitch: true }, DEFAULT_STRATEGY_LIMITS);
    expect(issues.map((i) => i.code)).toContain("PROTECTED_FIELD");
  });

  it("does not demand weights that already sum to one", () => {
    // The StrategyAgent's own prompt says weights are a relative mix, so
    // requiring an exact total would reject strategies the system produces.
    expect(validateStrategyContent(strategy({ formats: { reel: 0.5, carousel: 0.9 } }), DEFAULT_STRATEGY_LIMITS)).toEqual(
      [],
    );
    expect(normalizeWeights({ reel: 0.5, carousel: 0.9 }).reel).toBeCloseTo(0.357, 2);
  });
});

describe("strategy diff", () => {
  it("reports every changed weight with its delta", () => {
    const entries = diffStrategies(strategy(), strategy({ formats: { reel: 0.55, carousel: 0.25, image: 0.2 } }));

    expect(entries).toHaveLength(3);
    expect(entries.find((e) => e.target === "reel")).toMatchObject({ previous: 0.4, next: 0.55 });
    expect(entries.find((e) => e.target === "reel")!.delta).toBeCloseTo(0.15, 4);
  });

  it("describes the diff readably", () => {
    const summary = describeDiff(diffStrategies(strategy(), strategy({ postingFrequencyPerWeek: 5 })));
    expect(summary).toContain("postingFrequencyPerWeek 4.00 → 5.00");
  });

  it("reports nothing for identical strategies", () => {
    expect(diffStrategies(strategy(), strategy())).toEqual([]);
    expect(describeDiff([])).toBe("No changes.");
  });
});
