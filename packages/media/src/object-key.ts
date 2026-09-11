/**
 * Deterministic object keys. Two rules drive the shape:
 *
 *  - Never derive a key from a model-produced or user-supplied filename —
 *    that invites traversal ("../"), collisions and unbounded key lengths.
 *    Keys are built only from ids we generated ourselves.
 *  - Group by account then content so an account's media can be listed or
 *    lifecycled as a unit later without a database scan.
 *
 *   accounts/{accountId}/content/{contentId}/images/{assetId}.jpg
 *   accounts/{accountId}/content/{contentId}/videos/{assetId}.mp4
 *   accounts/{accountId}/content/{contentId}/thumbnails/{assetId}.jpg
 */

export type MediaKind = "images" | "videos" | "thumbnails";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export function extensionForMimeType(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? "bin";
}

/**
 * Ids come from `generateId()`/uuid, but this stays defensive: anything that
 * is not a safe path atom is replaced, so a malformed id can never escape its
 * prefix or introduce a "/" of its own.
 */
export function sanitizeKeySegment(segment: string): string {
  const cleaned = segment
    // Anything outside the safe set — "/" included — becomes a dash, which is
    // what actually prevents a segment from escaping its prefix.
    .replace(/[^A-Za-z0-9._-]/g, "-")
    // Collapse dot runs so no "../" lookalike survives even inside a segment.
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return cleaned.slice(0, 128) || "unknown";
}

export interface BuildObjectKeyInput {
  accountId: string;
  contentId: string;
  assetId: string;
  kind: MediaKind;
  mimeType: string;
  /** Test/scratch objects live under a dedicated prefix so they can never collide with real assets. */
  prefix?: string;
}

export function buildObjectKey(input: BuildObjectKeyInput): string {
  const segments = [
    input.prefix ? sanitizeKeySegment(input.prefix) : null,
    "accounts",
    sanitizeKeySegment(input.accountId),
    "content",
    sanitizeKeySegment(input.contentId),
    input.kind,
    `${sanitizeKeySegment(input.assetId)}.${extensionForMimeType(input.mimeType)}`,
  ].filter((s): s is string => s !== null);

  return segments.join("/");
}

/** Prefix reserved for integration-test objects, so a cleanup can never touch real media. */
export const TEST_KEY_PREFIX = "_test";
