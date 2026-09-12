/**
 * Platform-agnostic analytics contracts. Nothing here mentions Instagram or
 * Meta: adapters translate their provider's shape into these types, so the
 * analytics service, normalization layer and database stay reusable when a
 * second platform arrives.
 */

/**
 * One measurement. `available: false` is a first-class outcome, not an error
 * and not a zero — a metric the platform does not support for a given media
 * type must never be recorded as 0, or every average built on it is wrong.
 */
export interface PlatformMetric {
  /** Platform-native metric name, preserved for debugging normalization. */
  name: string;
  value?: number;
  available: boolean;
  /** Why an unavailable metric is unavailable — shown to operators, never invented. */
  reason?: string;
}

export type AnalyticsCollectionOutcome = "complete" | "partial" | "failed";

export interface MediaInsightsResult {
  externalPostId: string;
  /** IMAGE | VIDEO | CAROUSEL_ALBUM | REELS ... as reported by the platform. */
  mediaType?: string;
  mediaProductType?: string;
  permalink?: string;
  publishedAt?: string;
  metrics: PlatformMetric[];
  /** `partial` when some requested metrics could not be retrieved. */
  outcome: AnalyticsCollectionOutcome;
  capturedAt: string;
  /** Sanitized provider payload for debugging — never contains credentials. */
  raw: Record<string, unknown>;
}

export interface AccountInsightsResult {
  platformAccountId: string;
  username?: string;
  metrics: PlatformMetric[];
  outcome: AnalyticsCollectionOutcome;
  capturedAt: string;
  raw: Record<string, unknown>;
}

/**
 * Implemented by adapters that can report analytics. Kept separate from
 * `SocialPlatform` so a platform can support publishing without pretending to
 * support insights.
 */
export interface PlatformAnalyticsProvider {
  readonly platform: string;
  getMediaInsights(input: { externalPostId: string; accessToken: string }): Promise<MediaInsightsResult>;
  getAccountInsights(input: { platformAccountId: string; accessToken: string }): Promise<AccountInsightsResult>;
}
