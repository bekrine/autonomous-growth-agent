import type { PlatformMetric } from "@agent/social-platforms";

/**
 * Platform metric names → our canonical names.
 *
 * This mapping is why the rest of the system survives Meta renaming things:
 * `impressions` was retired in favour of `views` (April 2025), and both map to
 * the same canonical `views`. The platform's original name is preserved on
 * every normalized metric so a value can always be traced back to what the
 * API actually returned.
 */
const CANONICAL_NAMES: Record<string, string> = {
  // engagement
  likes: "likes",
  comments: "comments",
  shares: "shares",
  saved: "saves",
  saves: "saves",
  replies: "comments",
  total_interactions: "total_interactions",
  // distribution
  reach: "reach",
  views: "views",
  impressions: "views",
  video_views: "views",
  plays: "views",
  // profile activity
  follows: "follows",
  follower_count: "followers",
  followers_count: "followers",
  follows_count: "following",
  media_count: "media_count",
  profile_views: "profile_views",
  profile_visits: "profile_views",
  accounts_engaged: "accounts_engaged",
};

export function canonicalMetricName(platformName: string): string {
  return CANONICAL_NAMES[platformName.toLowerCase()] ?? platformName.toLowerCase();
}

export interface NormalizedMetric {
  name: string;
  platformName: string;
  value?: number;
  unit: string;
  available: boolean;
  unavailableReason?: string;
  source: "platform" | "derived";
  computation?: { formula: string; inputs: Record<string, number> };
}

/**
 * Converts raw platform metrics into canonical ones.
 *
 * Two invariants:
 *  - An unavailable metric stays unavailable. It is never coerced to 0, because
 *    "the platform didn't tell us" and "it was zero" mean different things and
 *    averaging them together silently corrupts every downstream number.
 *  - When two platform names collapse onto one canonical name (impressions and
 *    views), the available one wins rather than the last one seen.
 */
export function normalizeMetrics(platformMetrics: PlatformMetric[]): NormalizedMetric[] {
  const byCanonical = new Map<string, NormalizedMetric>();

  for (const metric of platformMetrics) {
    const name = canonicalMetricName(metric.name);
    const normalized: NormalizedMetric = {
      name,
      platformName: metric.name,
      value: metric.available ? metric.value : undefined,
      unit: "count",
      available: metric.available && typeof metric.value === "number",
      unavailableReason: metric.available ? undefined : metric.reason,
      source: "platform",
    };

    const existing = byCanonical.get(name);
    if (!existing || (!existing.available && normalized.available)) {
      byCanonical.set(name, normalized);
    }
  }

  return [...byCanonical.values()];
}

/** Convenience lookup used by the derived-metric calculations. */
export function metricValue(metrics: NormalizedMetric[], name: string): number | undefined {
  const metric = metrics.find((m) => m.name === name);
  return metric?.available ? metric.value : undefined;
}
