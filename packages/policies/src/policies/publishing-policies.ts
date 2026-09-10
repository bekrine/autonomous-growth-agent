import type { Policy, PolicyContext, PolicyResult } from "../types.js";

export const PUBLISH_ACTION = "publish_content";

/**
 * Publishing-specific policies. All of them no-op for non-publishing actions
 * so they can sit in the same PolicyEngine as the content/media policies.
 *
 * The payload is assembled by PublishingService, which loads the content,
 * connection and rate-limit counts before asking the engine — so policies
 * stay pure and synchronous.
 */

/** Only content that actually reached READY_FOR_PUBLISHING may be published. */
export class PublishableContentPolicy implements Policy {
  readonly name = "publishable-content";

  evaluate(context: PolicyContext): PolicyResult {
    if (context.actionType !== PUBLISH_ACTION) return { allowed: true };

    const status = context.payload.contentStatus;
    const publishable = status === "ready_for_publishing" || status === "queued" || status === "scheduled";
    if (!publishable) {
      return { allowed: false, reason: `Content has not passed review (status: ${String(status)})` };
    }

    if (context.payload.reviewApproved === false) {
      return { allowed: false, reason: "Content has not passed review." };
    }
    return { allowed: true };
  }
}

/** The account must have a healthy, non-expired connection to the target platform. */
export class SocialConnectionPolicy implements Policy {
  readonly name = "social-connection";

  evaluate(context: PolicyContext): PolicyResult {
    if (context.actionType !== PUBLISH_ACTION) return { allowed: true };

    const status = context.payload.connectionStatus;
    if (!status) return { allowed: false, reason: "No social connection is linked to this account." };
    if (status !== "connected") {
      return { allowed: false, reason: `The social connection is ${String(status)}. Reconnect the account.` };
    }

    const expiresAt = context.payload.connectionExpiresAt as string | undefined;
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      return { allowed: false, reason: "The social connection's access token has expired. Reconnect the account." };
    }

    const accountType = context.payload.accountType;
    if (accountType === "personal") {
      return {
        allowed: false,
        reason: "Publishing requires an Instagram Professional (Business or Creator) account.",
      };
    }
    return { allowed: true };
  }
}

/** Media must have passed validation before we spend a publish attempt. */
export class MediaReadyPolicy implements Policy {
  readonly name = "media-ready";

  evaluate(context: PolicyContext): PolicyResult {
    if (context.actionType !== PUBLISH_ACTION) return { allowed: true };
    if (context.payload.mediaValid === false) {
      const detail = context.payload.mediaIssue;
      return { allowed: false, reason: detail ? String(detail) : "The content's media is not publishable." };
    }
    return { allowed: true };
  }
}

export interface PublishingRateLimitOptions {
  maxPerDay: number;
  maxPerHour: number;
  minMinutesBetweenPosts: number;
}

/**
 * Our own publishing throttle, deliberately stricter than Instagram's
 * documented 100-posts/24h cap. The point is that a retry or queue bug can
 * never burn the real quota — we stop long before Meta would.
 *
 * Counts come from the database (publishing_jobs), so this holds across
 * process restarts and multiple workers, unlike the in-memory limiters.
 */
export class PublishingRateLimitPolicy implements Policy {
  readonly name = "publishing-rate-limit";

  constructor(private readonly options: PublishingRateLimitOptions) {}

  evaluate(context: PolicyContext): PolicyResult {
    if (context.actionType !== PUBLISH_ACTION) return { allowed: true };

    const publishedLastDay = Number(context.payload.publishedLastDay ?? 0);
    if (publishedLastDay >= this.options.maxPerDay) {
      return {
        allowed: false,
        reason: `Daily publishing limit reached (${this.options.maxPerDay}/day).`,
      };
    }

    const publishedLastHour = Number(context.payload.publishedLastHour ?? 0);
    if (publishedLastHour >= this.options.maxPerHour) {
      return {
        allowed: false,
        reason: `Hourly publishing limit reached (${this.options.maxPerHour}/hour).`,
      };
    }

    const lastPublishedAt = context.payload.lastPublishedAt as string | undefined;
    if (lastPublishedAt && this.options.minMinutesBetweenPosts > 0) {
      const elapsedMinutes = (Date.now() - new Date(lastPublishedAt).getTime()) / 60_000;
      if (elapsedMinutes < this.options.minMinutesBetweenPosts) {
        const wait = Math.ceil(this.options.minMinutesBetweenPosts - elapsedMinutes);
        return { allowed: false, reason: `Minimum spacing between posts not met — try again in ~${wait} minute(s).` };
      }
    }

    return { allowed: true };
  }
}

/**
 * Autonomous (agent-initiated) publishing stays off until the manual path is
 * proven. Human/API-initiated publishes set `initiatedBy: "human"` and are
 * unaffected.
 */
export class AutoPublishPolicy implements Policy {
  readonly name = "auto-publish-enabled";

  constructor(private readonly autoPublishEnabled: boolean) {}

  evaluate(context: PolicyContext): PolicyResult {
    if (context.actionType !== PUBLISH_ACTION) return { allowed: true };
    if (context.payload.initiatedBy !== "agent") return { allowed: true };
    if (this.autoPublishEnabled) return { allowed: true };
    return {
      allowed: false,
      reason: "Autonomous publishing is disabled (AUTO_PUBLISH_ENABLED=false). Publish manually to approve.",
    };
  }
}

/** A cancelled or already-published job must never publish, whatever else says. */
export class PublishingJobStatePolicy implements Policy {
  readonly name = "publishing-job-state";

  evaluate(context: PolicyContext): PolicyResult {
    if (context.actionType !== PUBLISH_ACTION) return { allowed: true };

    const jobStatus = context.payload.jobStatus;
    if (jobStatus === "cancelled") return { allowed: false, reason: "This publishing job was cancelled." };
    if (jobStatus === "published") return { allowed: false, reason: "This content has already been published." };

    const scheduledFor = context.payload.scheduledFor as string | undefined;
    if (scheduledFor && new Date(scheduledFor).getTime() > Date.now() + 60_000) {
      return { allowed: false, reason: "This job is scheduled for a later time." };
    }
    return { allowed: true };
  }
}
