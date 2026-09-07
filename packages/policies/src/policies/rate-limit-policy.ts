import type { Policy, PolicyContext, PolicyResult } from "../types.js";

interface RateLimitWindow {
  count: number;
  windowStart: number;
}

/**
 * Simple in-memory sliding-window limiter per (account, actionType). Good
 * enough for a single-process foundation; a multi-instance deployment
 * should move the counters into Redis.
 */
export class RateLimitPolicy implements Policy {
  readonly name = "rate-limit";
  private readonly windows = new Map<string, RateLimitWindow>();

  constructor(
    private readonly maxActionsPerWindow: number = 10,
    private readonly windowMs: number = 60 * 60 * 1000,
  ) {}

  evaluate(context: PolicyContext): PolicyResult {
    const key = `${context.accountId}:${context.actionType}`;
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || now - existing.windowStart > this.windowMs) {
      this.windows.set(key, { count: 1, windowStart: now });
      return { allowed: true };
    }

    if (existing.count >= this.maxActionsPerWindow) {
      return {
        allowed: false,
        reason: `Rate limit exceeded for ${context.actionType} (${this.maxActionsPerWindow} per ${
          this.windowMs / 60000
        }min)`,
      };
    }

    existing.count += 1;
    return { allowed: true };
  }
}
