import { PublishingError, type PublishMediaItem } from "./publishing-types.js";
import type { PublishPostKind } from "@agent/shared";

/**
 * Meta's documented constraint: "JPEG is the only image format supported.
 * Extended JPEG formats such as MPO and JPS are not supported."
 * This is why MockImageGenerator's SVG output cannot be published as-is.
 */
const INSTAGRAM_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg"]);
const INSTAGRAM_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime"]);
const MAX_CAROUSEL_ITEMS = 10;

export interface MediaValidationIssue {
  code: "MEDIA_INVALID" | "MEDIA_NOT_ACCESSIBLE";
  message: string;
}

export interface MediaValidationResult {
  valid: boolean;
  issues: MediaValidationIssue[];
}

/**
 * Static (no-network) validation of a post's media against Instagram's
 * requirements. Checked before any Meta call so obviously-unpublishable
 * content fails fast with an actionable message instead of consuming
 * publishing quota and retry attempts.
 *
 * Deliberately checks declared mime types rather than file extensions —
 * an extension says nothing about actual content.
 */
export function validateInstagramMedia(kind: PublishPostKind, media: PublishMediaItem[]): MediaValidationResult {
  const issues: MediaValidationIssue[] = [];

  if (kind === "text") {
    issues.push({ code: "MEDIA_INVALID", message: "Instagram requires media; text-only posts cannot be published." });
    return { valid: false, issues };
  }

  if (media.length === 0) {
    issues.push({ code: "MEDIA_INVALID", message: "No media was attached to this content." });
    return { valid: false, issues };
  }

  for (const item of media) {
    if (!isPubliclyFetchableUrl(item.url)) {
      issues.push({
        code: "MEDIA_NOT_ACCESSIBLE",
        message: `Media URL is not publicly reachable by Meta's servers: ${redactUrl(item.url)}. Instagram downloads media server-side, so localhost and private addresses will fail.`,
      });
    }

    if (item.kind === "image" && !INSTAGRAM_IMAGE_MIME_TYPES.has(item.mimeType.toLowerCase())) {
      issues.push({
        code: "MEDIA_INVALID",
        message: `Instagram accepts JPEG images only (got ${item.mimeType}).`,
      });
    }

    if (item.kind === "video" && !INSTAGRAM_VIDEO_MIME_TYPES.has(item.mimeType.toLowerCase())) {
      issues.push({
        code: "MEDIA_INVALID",
        message: `Instagram accepts MP4/MOV video only (got ${item.mimeType}).`,
      });
    }
  }

  if (kind === "reel" && !media.some((m) => m.kind === "video")) {
    issues.push({ code: "MEDIA_INVALID", message: "A Reel requires a video asset." });
  }

  if (kind === "image" && !media.some((m) => m.kind === "image")) {
    issues.push({ code: "MEDIA_INVALID", message: "An image post requires an image asset." });
  }

  if (kind === "carousel" && (media.length < 2 || media.length > MAX_CAROUSEL_ITEMS)) {
    issues.push({
      code: "MEDIA_INVALID",
      message: `A carousel needs between 2 and ${MAX_CAROUSEL_ITEMS} items (got ${media.length}).`,
    });
  }

  return { valid: issues.length === 0, issues };
}

/** Throwing variant for call sites that treat invalid media as a hard stop. */
export function assertInstagramMedia(kind: PublishPostKind, media: PublishMediaItem[]): void {
  const result = validateInstagramMedia(kind, media);
  if (!result.valid) {
    const first = result.issues[0];
    throw new PublishingError(first.code, first.message, result.issues.map((i) => i.message).join("; "));
  }
}

/**
 * Meta fetches media from its own servers, so loopback/private/non-HTTPS
 * hosts can never work regardless of whether they resolve locally.
 */
export function isPubliclyFetchableUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return false;

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) return false;
  // RFC1918 / link-local ranges.
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;

  return true;
}

/** Strips query strings (which may carry signed-URL credentials) before logging. */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(invalid url)";
  }
}
