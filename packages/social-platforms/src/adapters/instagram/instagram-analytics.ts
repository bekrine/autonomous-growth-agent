import type { MetaGraphClient } from "./graph-client.js";
import { PublishingError } from "../../publishing-types.js";
import type {
  AccountInsightsResult,
  AnalyticsCollectionOutcome,
  MediaInsightsResult,
  PlatformAnalyticsProvider,
  PlatformMetric,
} from "../../analytics-types.js";

/**
 * Instagram insights via the Meta Graph API.
 *
 * Meta's insights metric set is a moving target — `impressions` and
 * `video_views` were retired in favour of `views` (April 2025), and the valid
 * set differs by media product type. So this adapter **discovers** what is
 * available instead of assuming: it requests each candidate metric and records
 * anything the API rejects as `available: false` with the platform's own
 * reason. A metric we cannot read is never silently reported as 0.
 *
 * Requires the `instagram_manage_insights` permission. Without it every
 * insights call fails with "(#10) Application does not have permission for
 * this action" while basic fields still succeed — which is why permission
 * failures are surfaced explicitly rather than collapsed into "no data".
 */

/** Candidates per media product type, current as of Graph API v21–v23. */
const FEED_METRICS = ["reach", "likes", "comments", "shares", "saved", "views", "total_interactions", "follows", "profile_visits"];
const REELS_METRICS = ["reach", "likes", "comments", "shares", "saved", "views", "total_interactions"];
const STORY_METRICS = ["reach", "views", "replies", "total_interactions"];

export function candidateMetricsFor(mediaProductType?: string, mediaType?: string): string[] {
  const productType = (mediaProductType ?? "").toUpperCase();
  if (productType === "REELS" || (mediaType ?? "").toUpperCase() === "REELS") return REELS_METRICS;
  if (productType === "STORY") return STORY_METRICS;
  return FEED_METRICS;
}

/** Account-level fields readable without the insights permission. */
const ACCOUNT_FIELDS = ["followers_count", "follows_count", "media_count"] as const;
/** Account-level insights that DO need `instagram_manage_insights`. */
const ACCOUNT_INSIGHT_METRICS = ["reach", "views", "profile_views", "accounts_engaged"] as const;

export class InstagramAnalyticsProvider implements PlatformAnalyticsProvider {
  readonly platform = "instagram";

  constructor(private readonly client: MetaGraphClient) {}

  async getMediaInsights(input: { externalPostId: string; accessToken: string }): Promise<MediaInsightsResult> {
    const capturedAt = new Date().toISOString();

    // Media fields first: these work without the insights permission, so even
    // a permission-denied account still yields media type and permalink.
    const fields = await this.client.get<{
      id: string;
      media_type?: string;
      media_product_type?: string;
      permalink?: string;
      timestamp?: string;
    }>(input.externalPostId, {
      fields: "id,media_type,media_product_type,permalink,timestamp",
      access_token: input.accessToken,
    });

    const candidates = candidateMetricsFor(fields.media_product_type, fields.media_type);
    const { metrics, rawValues, outcome } = await this.collectMetrics(
      `${input.externalPostId}/insights`,
      candidates,
      input.accessToken,
    );

    return {
      externalPostId: input.externalPostId,
      mediaType: fields.media_type,
      mediaProductType: fields.media_product_type,
      permalink: fields.permalink,
      publishedAt: fields.timestamp,
      metrics,
      outcome,
      capturedAt,
      raw: sanitizeRaw({ fields, insights: rawValues }),
    };
  }

  async getAccountInsights(input: { platformAccountId: string; accessToken: string }): Promise<AccountInsightsResult> {
    const capturedAt = new Date().toISOString();

    const profile = await this.client.get<Record<string, unknown>>(input.platformAccountId, {
      fields: `username,${ACCOUNT_FIELDS.join(",")}`,
      access_token: input.accessToken,
    });

    const metrics: PlatformMetric[] = ACCOUNT_FIELDS.map((field) => {
      const value = profile[field];
      return typeof value === "number"
        ? { name: field, value, available: true }
        : { name: field, available: false, reason: "Not returned by the platform for this account" };
    });

    const insights = await this.collectMetrics(
      `${input.platformAccountId}/insights`,
      [...ACCOUNT_INSIGHT_METRICS],
      input.accessToken,
      { period: "day", metric_type: "total_value" },
    );

    metrics.push(...insights.metrics);

    // Profile counts are the part that must keep working: treat the snapshot as
    // complete when those succeeded, even if insight metrics were denied.
    const profileComplete = metrics
      .filter((m) => (ACCOUNT_FIELDS as readonly string[]).includes(m.name))
      .every((m) => m.available);

    return {
      platformAccountId: input.platformAccountId,
      username: typeof profile.username === "string" ? profile.username : undefined,
      metrics,
      outcome: profileComplete && insights.outcome === "complete" ? "complete" : profileComplete ? "partial" : "failed",
      capturedAt,
      raw: sanitizeRaw({ profile, insights: insights.rawValues }),
    };
  }

  /**
   * Requests metrics one at a time. A batched request fails wholesale if any
   * single name is invalid, which would lose every other metric — so the cost
   * of extra calls buys per-metric availability instead of all-or-nothing.
   */
  private async collectMetrics(
    path: string,
    candidates: string[],
    accessToken: string,
    extraParams: Record<string, string> = {},
  ): Promise<{ metrics: PlatformMetric[]; rawValues: Record<string, unknown>; outcome: AnalyticsCollectionOutcome }> {
    const metrics: PlatformMetric[] = [];
    const rawValues: Record<string, unknown> = {};
    let availableCount = 0;

    for (const metric of candidates) {
      try {
        const response = await this.client.get<{ data?: InsightEntry[] }>(path, {
          metric,
          access_token: accessToken,
          ...extraParams,
        });
        const entry = response.data?.[0];
        const value = extractValue(entry);

        if (value === undefined) {
          metrics.push({ name: metric, available: false, reason: "Platform returned no value for this metric" });
        } else {
          metrics.push({ name: metric, value, available: true });
          rawValues[metric] = entry;
          availableCount += 1;
        }
      } catch (error) {
        metrics.push({ name: metric, available: false, reason: describeMetricFailure(error) });
      }
    }

    const outcome: AnalyticsCollectionOutcome =
      availableCount === candidates.length ? "complete" : availableCount === 0 ? "failed" : "partial";

    return { metrics, rawValues, outcome };
  }
}

interface InsightEntry {
  name?: string;
  period?: string;
  values?: { value?: unknown }[];
  total_value?: { value?: unknown };
}

/** Handles both response shapes: `values[0].value` and `total_value.value`. */
function extractValue(entry: InsightEntry | undefined): number | undefined {
  if (!entry) return undefined;
  const candidate = entry.total_value?.value ?? entry.values?.[0]?.value;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

/**
 * Turns a provider failure into a short operator-facing reason. Meta's raw
 * message can include internal trace ids, so only recognised cases produce a
 * specific explanation.
 */
export function describeMetricFailure(error: unknown): string {
  if (error instanceof PublishingError) {
    if (error.publishingErrorCode === "PERMISSION_DENIED") {
      return "Permission denied — the connection is missing instagram_manage_insights. Reconnect the account.";
    }
    if (error.publishingErrorCode === "AUTHENTICATION_FAILED") return "The stored credential is no longer valid.";
    if (error.publishingErrorCode === "RATE_LIMITED") return "Rate limited by the platform.";
    return "Metric unavailable for this media type or API version.";
  }
  return "Metric could not be retrieved.";
}

const CREDENTIAL_KEYS = /access_token|client_secret|app_secret|code|token/i;

/**
 * Strips anything credential-shaped before a payload is persisted. Analytics
 * rows are long-lived and widely read, so a token must never reach them.
 */
export function sanitizeRaw(payload: unknown): Record<string, unknown> {
  return sanitizeValue(payload) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = CREDENTIAL_KEYS.test(key) ? "[redacted]" : sanitizeValue(entry);
    }
    return result;
  }
  return value;
}
