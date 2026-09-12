import { describe, expect, it } from "vitest";
import type { PlatformMetric } from "@agent/social-platforms";
import { canonicalMetricName, normalizeMetrics, metricValue } from "../analytics/normalization.js";
import { calculateDerivedMetrics, compareToBaseline, median } from "../analytics/derived-metrics.js";
import {
  calculateAccountBaseline,
  calculatePerformanceScore,
  DEFAULT_PERFORMANCE_WEIGHTS,
} from "../analytics/performance-scoring.js";
import {
  nextWindow,
  parseCollectionWindows,
  windowDueNow,
  DEFAULT_COLLECTION_WINDOWS,
} from "../analytics/collection-windows.js";

function platformMetric(name: string, value?: number, reason?: string): PlatformMetric {
  return value === undefined ? { name, available: false, reason } : { name, value, available: true };
}

describe("metric normalization", () => {
  it("maps Meta's renamed metrics onto stable canonical names", () => {
    // impressions was retired in favour of views (April 2025); both must land
    // on the same canonical name or historical data becomes incomparable.
    expect(canonicalMetricName("impressions")).toBe("views");
    expect(canonicalMetricName("views")).toBe("views");
    expect(canonicalMetricName("saved")).toBe("saves");
    expect(canonicalMetricName("followers_count")).toBe("followers");
  });

  it("keeps the platform's own name alongside the canonical one", () => {
    const [metric] = normalizeMetrics([platformMetric("saved", 91)]);
    expect(metric).toMatchObject({ name: "saves", platformName: "saved", value: 91, available: true });
  });

  it("preserves unavailability instead of coercing it to zero", () => {
    const [metric] = normalizeMetrics([platformMetric("shares", undefined, "Not supported for this media type")]);

    expect(metric!.available).toBe(false);
    expect(metric!.value).toBeUndefined();
    // The distinction that matters: absent is not zero.
    expect(metric!.value).not.toBe(0);
    expect(metric!.unavailableReason).toBe("Not supported for this media type");
  });

  it("prefers the available reading when two platform names collapse to one canonical name", () => {
    const metrics = normalizeMetrics([
      platformMetric("impressions", undefined, "deprecated"),
      platformMetric("views", 1200),
    ]);

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ name: "views", value: 1200, available: true });
  });

  it("treats a malformed reading (missing value) as unavailable", () => {
    const [metric] = normalizeMetrics([{ name: "reach", available: true } as PlatformMetric]);
    expect(metric!.available).toBe(false);
  });
});

describe("derived metrics", () => {
  const complete = normalizeMetrics([
    platformMetric("reach", 1000),
    platformMetric("likes", 80),
    platformMetric("comments", 10),
    platformMetric("shares", 6),
    platformMetric("saved", 4),
    platformMetric("follows", 5),
    platformMetric("views", 2000),
  ]);

  it("computes engagement, share, save and follow rates", () => {
    const derived = calculateDerivedMetrics(complete);
    const byName = Object.fromEntries(derived.map((m) => [m.name, m]));

    expect(byName.engagement_rate!.value).toBeCloseTo(0.1); // (80+10+6+4)/1000
    expect(byName.share_rate!.value).toBeCloseTo(0.006);
    expect(byName.save_rate!.value).toBeCloseTo(0.004);
    expect(byName.follow_conversion!.value).toBeCloseTo(0.005);
    expect(byName.views_to_follow_conversion!.value).toBeCloseTo(0.0025);
  });

  it("records the formula and inputs so every number is auditable", () => {
    const rate = calculateDerivedMetrics(complete).find((m) => m.name === "engagement_rate")!;

    expect(rate.computation?.formula).toBe("(likes + comments + shares + saves) / reach");
    expect(rate.computation?.inputs).toMatchObject({ likes: 80, comments: 10, shares: 6, saves: 4, reach: 1000 });
    expect(rate.source).toBe("derived");
  });

  it("refuses to divide by zero rather than reporting 0%", () => {
    const metrics = normalizeMetrics([
      platformMetric("reach", 0),
      platformMetric("likes", 0),
      platformMetric("comments", 0),
      platformMetric("shares", 0),
      platformMetric("saved", 0),
    ]);
    const rate = calculateDerivedMetrics(metrics).find((m) => m.name === "engagement_rate")!;

    expect(rate.available).toBe(false);
    expect(rate.value).toBeUndefined();
    expect(rate.unavailableReason).toContain("reach is 0");
  });

  it("does not compute when the denominator is unavailable", () => {
    const metrics = normalizeMetrics([platformMetric("likes", 10), platformMetric("reach", undefined, "denied")]);
    const rate = calculateDerivedMetrics(metrics).find((m) => m.name === "engagement_rate")!;

    expect(rate.available).toBe(false);
    expect(rate.unavailableReason).toContain("reach is unavailable");
  });

  it("does not compute when a numerator component is unavailable, rather than treating it as zero", () => {
    const metrics = normalizeMetrics([
      platformMetric("reach", 1000),
      platformMetric("likes", 80),
      platformMetric("comments", 10),
      platformMetric("shares", undefined, "not supported"),
      platformMetric("saved", 4),
    ]);
    const rate = calculateDerivedMetrics(metrics).find((m) => m.name === "engagement_rate")!;

    expect(rate.available).toBe(false);
    expect(rate.unavailableReason).toContain("shares is unavailable");
  });
});

describe("baseline comparison", () => {
  it("expresses performance as a multiple of the baseline", () => {
    const comparison = compareToBaseline(8400, 3100, "reach");
    expect(comparison.available).toBe(true);
    expect(comparison.value).toBeCloseTo(2.71, 2);
    expect(comparison.computation?.inputs).toMatchObject({ value: 8400, baseline: 3100 });
  });

  it("refuses to compare against a zero or missing baseline", () => {
    expect(compareToBaseline(100, 0, "reach").available).toBe(false);
    expect(compareToBaseline(100, undefined, "reach").available).toBe(false);
    expect(compareToBaseline(undefined, 50, "reach").available).toBe(false);
  });

  it("uses the median so one viral post cannot distort the baseline", () => {
    // A mean here would be 2218; the median stays representative.
    expect(median([100, 120, 140, 150, 10_600])).toBe(140);
    expect(median([])).toBeUndefined();
  });
});

describe("account baseline", () => {
  it("medians each metric over the configured window independently", () => {
    const baseline = calculateAccountBaseline(
      [
        { contentPostId: "1", metrics: { reach: 100, saves: 5 } },
        { contentPostId: "2", metrics: { reach: 300, saves: undefined } },
        { contentPostId: "3", metrics: { reach: 200, saves: 15 } },
        { contentPostId: "4", metrics: { reach: 9999, saves: 1 } },
      ],
      3,
    );

    expect(baseline.sampleSize).toBe(3);
    expect(baseline.metrics.reach).toBe(200);
    // saves only had two readings in the window; the third is not invented.
    expect(baseline.metrics.saves).toBe(10);
  });
});

describe("performance score", () => {
  const baseline = calculateAccountBaseline(
    [{ contentPostId: "1", metrics: { reach: 1000, engagement_rate: 0.05, shares: 10, saves: 10, follows: 5 } }],
    10,
  );

  it("scores a post relative to the account baseline", () => {
    const result = calculatePerformanceScore(
      { reach: 2000, engagement_rate: 0.1, shares: 20, saves: 20, follows: 10 },
      baseline,
    );

    // Every component is exactly 2x the baseline, so the score is 2.
    expect(result.available).toBe(true);
    expect(result.score).toBeCloseTo(2);
    expect(result.coverage).toBeCloseTo(1);
  });

  it("renormalizes over available components and reports reduced coverage", () => {
    const result = calculatePerformanceScore({ reach: 2000, engagement_rate: 0.1 }, baseline);

    expect(result.available).toBe(true);
    expect(result.score).toBeCloseTo(2);
    // reach (0.30) + engagement (0.20) only.
    expect(result.coverage).toBeCloseTo(0.5);
    expect(result.components.filter((c) => !c.available)).toHaveLength(3);
  });

  it("is unavailable — not zero — when nothing can be scored", () => {
    const result = calculatePerformanceScore({}, baseline);
    expect(result.available).toBe(false);
    expect(result.score).toBeUndefined();
    expect(result.unavailableReason).toBeTruthy();
  });

  it("exposes the weights as a readable formula", () => {
    const result = calculatePerformanceScore({ reach: 1000 }, baseline, DEFAULT_PERFORMANCE_WEIGHTS);
    expect(result.formula).toContain("0.3 x normalized_reach");
  });
});

describe("collection windows", () => {
  const publishedAt = new Date("2026-09-01T00:00:00Z");

  it("uses the documented default ladder", () => {
    expect(DEFAULT_COLLECTION_WINDOWS.map((w) => w.offsetMinutes)).toEqual([60, 360, 1440, 4320]);
  });

  it("parses a configured ladder and keeps it ordered", () => {
    expect(parseCollectionWindows("1440,60,360").map((w) => w.offsetMinutes)).toEqual([60, 360, 1440]);
    expect(parseCollectionWindows("")).toEqual(DEFAULT_COLLECTION_WINDOWS);
    expect(parseCollectionWindows("nonsense")).toEqual(DEFAULT_COLLECTION_WINDOWS);
  });

  it("advances through the ladder and then stops", () => {
    expect(nextWindow(publishedAt, [])!.window.name).toBe("initial");
    expect(nextWindow(publishedAt, ["initial"])!.window.name).toBe("early");
    // Ladder exhausted — collection ends rather than polling forever.
    expect(nextWindow(publishedAt, ["initial", "early", "daily", "extended"])).toBeUndefined();
  });

  it("selects the furthest due window rather than replaying earlier ones", () => {
    // Worker running 30h late: the platform only reports current totals, so
    // backfilling 'initial' and 'early' would store identical numbers thrice.
    const now = new Date(publishedAt.getTime() + 30 * 60 * 60_000);
    expect(windowDueNow(publishedAt, [], now)!.name).toBe("daily");
  });

  it("returns nothing when no window is due yet", () => {
    const now = new Date(publishedAt.getTime() + 10 * 60_000);
    expect(windowDueNow(publishedAt, [], now)).toBeUndefined();
  });
});

describe("metricValue helper", () => {
  it("returns undefined for unavailable metrics", () => {
    const metrics = normalizeMetrics([platformMetric("reach", undefined, "denied")]);
    expect(metricValue(metrics, "reach")).toBeUndefined();
  });
});
