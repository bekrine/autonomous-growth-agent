import type { PublishingErrorCode, PublishPostKind } from "@agent/shared";
import { AppError } from "@agent/shared";

/** One media item to publish, already resolved to a URL Meta's servers can fetch. */
export interface PublishMediaItem {
  kind: "image" | "video";
  /** Publicly reachable URL — Meta fetches this server-side, so localhost will not work. */
  url: string;
  mimeType: string;
}

/**
 * Platform-agnostic publish request. `kind` describes the post shape;
 * adapters map it to platform concepts (e.g. Instagram REELS/CAROUSEL).
 */
export interface PublishPostRequest {
  /** Platform-side account id (e.g. Instagram user id), not our internal account id. */
  platformAccountId: string;
  accessToken: string;
  kind: PublishPostKind;
  caption: string;
  altText?: string;
  media: PublishMediaItem[];
  /**
   * A container created by a previous attempt. When present the adapter
   * resumes from it instead of creating a new one — this is what stops a
   * retry from producing a duplicate post.
   */
  existingContainerId?: string;
  /** Reports the container id as soon as it exists, so a crash mid-publish is still resumable. */
  onContainerCreated?: (containerId: string) => Promise<void>;
}

export interface PublishPostOutcome {
  externalPostId: string;
  externalContainerId?: string;
  publishedAt: string;
}

/** Normalized publishing failure. Adapters translate provider errors into this. */
export class PublishingError extends AppError {
  readonly publishingErrorCode: PublishingErrorCode;
  /** Provider detail kept for logs/DB only — never surfaced verbatim to the browser. */
  readonly providerDetail?: string;

  constructor(code: PublishingErrorCode, message: string, providerDetail?: string) {
    super(message, { statusCode: 502, code });
    this.publishingErrorCode = code;
    this.providerDetail = providerDetail;
  }
}

/**
 * Resolves a stored asset to a URL Meta can fetch. Implemented outside the
 * adapter so storage concerns (local disk, signed S3 URLs, a CDN) never leak
 * into platform code.
 */
export interface PublicMediaResolver {
  getPublicUrl(assetId: string): Promise<string>;
}
