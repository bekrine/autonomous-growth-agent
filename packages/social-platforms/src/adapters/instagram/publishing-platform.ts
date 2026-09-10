import type { PublishPostOutcome, PublishPostRequest } from "../../publishing-types.js";

/**
 * The publishing surface PublishingService depends on — deliberately
 * narrower than SocialPlatform. Both InstagramAdapter and
 * MockInstagramAdapter implement it, so swapping real for mock is a
 * one-line factory change and the service can't tell the difference.
 */
export interface PublishingPlatform {
  readonly platform: "instagram" | "facebook";
  publish(request: PublishPostRequest): Promise<PublishPostOutcome>;
  /** Current usage against the platform's rolling publishing quota. */
  getPublishingLimit(platformAccountId: string, accessToken: string): Promise<{ used: number; cap: number }>;
}
