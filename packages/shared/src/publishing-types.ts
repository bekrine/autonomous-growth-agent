/**
 * Normalized publishing failure codes. Adapters translate provider-specific
 * errors (Meta error subcodes, HTTP statuses) into these so the rest of the
 * system — retry logic, dashboards, policy — never inspects raw Meta output.
 */
export const PUBLISHING_ERROR_CODES = [
  "AUTHENTICATION_FAILED",
  "PERMISSION_DENIED",
  "ACCOUNT_NOT_SUPPORTED",
  "MEDIA_INVALID",
  "MEDIA_NOT_ACCESSIBLE",
  "RATE_LIMITED",
  "CONTAINER_FAILED",
  "CONTAINER_EXPIRED",
  "PLATFORM_ERROR",
  "POLICY_DENIED",
  "UNKNOWN",
] as const;

export type PublishingErrorCode = (typeof PUBLISHING_ERROR_CODES)[number];

/**
 * Which failures are worth retrying. Anything caused by bad credentials,
 * missing permissions, or invalid content will fail identically forever —
 * retrying those just burns quota and delays the operator finding out.
 */
const RETRYABLE: ReadonlySet<PublishingErrorCode> = new Set<PublishingErrorCode>([
  "RATE_LIMITED",
  "PLATFORM_ERROR",
  "CONTAINER_FAILED",
  "UNKNOWN",
]);

export function isRetryablePublishingError(code: PublishingErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** Media kinds the publishing pipeline understands, independent of any platform. */
export const PUBLISH_MEDIA_KINDS = ["image", "video"] as const;
export type PublishMediaKind = (typeof PUBLISH_MEDIA_KINDS)[number];

export const PUBLISH_POST_KINDS = ["image", "reel", "carousel", "text"] as const;
export type PublishPostKind = (typeof PUBLISH_POST_KINDS)[number];
