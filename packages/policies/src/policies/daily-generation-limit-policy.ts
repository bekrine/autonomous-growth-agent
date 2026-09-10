import type { Policy, PolicyContext, PolicyResult } from "../types.js";

const MEDIA_GENERATION_ACTIONS = new Set(["generateImage", "generateVideo"]);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Rough placeholder unit cost for observability until real provider billing is wired in. */
const ESTIMATED_COST_PER_GENERATION_USD = 0.01;

interface DailyWindow {
  count: number;
  windowStart: number;
}

/**
 * Cost control for media generation specifically (section 36): a per-account,
 * per-day cap on image/video generation calls, independent of the generic
 * RateLimitPolicy's hourly limit. In-memory — a multi-instance deployment
 * should move counters into Redis, same caveat as RateLimitPolicy.
 */
export class DailyGenerationLimitPolicy implements Policy {
  readonly name = "daily-generation-limit";
  private readonly windows = new Map<string, DailyWindow>();

  constructor(private readonly maxPerDay: number = 50) {}

  evaluate(context: PolicyContext): PolicyResult {
    if (!MEDIA_GENERATION_ACTIONS.has(context.actionType)) {
      return { allowed: true };
    }

    const now = Date.now();
    const existing = this.windows.get(context.accountId);

    if (!existing || now - existing.windowStart > DAY_MS) {
      this.windows.set(context.accountId, { count: 1, windowStart: now });
      return { allowed: true };
    }

    if (existing.count >= this.maxPerDay) {
      return {
        allowed: false,
        reason: `Daily media generation limit reached (${this.maxPerDay}/day, ~$${(
          this.maxPerDay * ESTIMATED_COST_PER_GENERATION_USD
        ).toFixed(2)} estimated)`,
      };
    }

    existing.count += 1;
    return { allowed: true };
  }

  /** For observability/logging — not enforced here, just surfaced. */
  estimatedCostUsd(count: number): number {
    return count * ESTIMATED_COST_PER_GENERATION_USD;
  }
}
