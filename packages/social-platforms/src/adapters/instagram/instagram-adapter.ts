import type { Logger } from "@agent/shared";
import type {
  Comment,
  PostAnalytics,
  PublishPostInput,
  PublishResult,
  ReplyInput,
  ReplyResult,
  SocialPlatform,
  SocialPost,
} from "../../types.js";
import {
  PublishingError,
  type PublishPostOutcome,
  type PublishPostRequest,
} from "../../publishing-types.js";
import { MetaGraphClient } from "./graph-client.js";

/** Container states Meta reports via `?fields=status_code`. */
type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export interface InstagramAdapterOptions {
  apiVersion: string;
  host: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Meta recommends polling once per minute for up to 5 minutes. */
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 60;
/** Meta's documented carousel maximum. */
const MAX_CAROUSEL_ITEMS = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real Instagram publishing via the Meta Graph API, following the documented
 * flow: create a media container -> poll until FINISHED -> media_publish.
 *
 *   image:    POST /{ig-id}/media { image_url, caption, alt_text }
 *   reel:     POST /{ig-id}/media { media_type: REELS, video_url, caption }
 *   carousel: POST /{ig-id}/media { ..., is_carousel_item: true } per item,
 *             then POST /{ig-id}/media { media_type: CAROUSEL, children }
 *   publish:  POST /{ig-id}/media_publish { creation_id }
 *
 * Only publishPost() is implemented for Phase 4; the read methods remain
 * clearly stubbed and are Phase 5 (analytics) work.
 */
export class InstagramAdapter implements SocialPlatform {
  readonly platform = "instagram" as const;
  private readonly client: MetaGraphClient;
  private readonly logger?: Logger;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;

  constructor(options: InstagramAdapterOptions) {
    this.client = new MetaGraphClient({
      apiVersion: options.apiVersion,
      host: options.host,
      fetchImpl: options.fetchImpl,
    });
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  }

  /** The Phase 4 entry point. `publishPost` (SocialPlatform) delegates here. */
  async publish(request: PublishPostRequest): Promise<PublishPostOutcome> {
    const containerId = request.existingContainerId ?? (await this.createContainer(request));

    // Surfaced immediately so a crash between here and media_publish leaves a
    // resumable container id rather than an orphaned Instagram container.
    if (!request.existingContainerId) {
      await request.onContainerCreated?.(containerId);
    }

    await this.waitForContainerReady(containerId, request.accessToken);

    const published = await this.client.post<{ id: string }>(`${request.platformAccountId}/media_publish`, {
      creation_id: containerId,
      access_token: request.accessToken,
    });

    return {
      externalPostId: published.id,
      externalContainerId: containerId,
      publishedAt: new Date().toISOString(),
    };
  }

  private async createContainer(request: PublishPostRequest): Promise<string> {
    switch (request.kind) {
      case "image":
        return this.createImageContainer(request);
      case "reel":
        return this.createReelContainer(request);
      case "carousel":
        return this.createCarouselContainer(request);
      case "text":
        // Instagram has no text-only post type — this is a caller error, not
        // a platform failure, so it must never be retried.
        throw new PublishingError(
          "MEDIA_INVALID",
          "Instagram requires media; text-only content cannot be published.",
        );
      default:
        throw new PublishingError("MEDIA_INVALID", `Unsupported post kind: ${request.kind}`);
    }
  }

  private firstMediaOfKind(request: PublishPostRequest, kind: "image" | "video") {
    const item = request.media.find((m) => m.kind === kind);
    if (!item) {
      throw new PublishingError("MEDIA_INVALID", `No ${kind} media was supplied for an Instagram ${request.kind}.`);
    }
    return item;
  }

  private async createImageContainer(request: PublishPostRequest): Promise<string> {
    const image = this.firstMediaOfKind(request, "image");
    const params: Record<string, string> = {
      image_url: image.url,
      caption: request.caption,
      access_token: request.accessToken,
    };
    if (request.altText) params.alt_text = request.altText;

    const result = await this.client.post<{ id: string }>(`${request.platformAccountId}/media`, params);
    return result.id;
  }

  private async createReelContainer(request: PublishPostRequest): Promise<string> {
    const video = this.firstMediaOfKind(request, "video");
    const result = await this.client.post<{ id: string }>(`${request.platformAccountId}/media`, {
      media_type: "REELS",
      video_url: video.url,
      caption: request.caption,
      access_token: request.accessToken,
    });
    return result.id;
  }

  private async createCarouselContainer(request: PublishPostRequest): Promise<string> {
    if (request.media.length < 2 || request.media.length > MAX_CAROUSEL_ITEMS) {
      throw new PublishingError(
        "MEDIA_INVALID",
        `An Instagram carousel needs between 2 and ${MAX_CAROUSEL_ITEMS} items (got ${request.media.length}).`,
      );
    }

    // Children must each be created first, then referenced by the parent.
    const childIds: string[] = [];
    for (const item of request.media) {
      const params: Record<string, string> = {
        is_carousel_item: "true",
        access_token: request.accessToken,
      };
      if (item.kind === "image") {
        params.image_url = item.url;
      } else {
        params.media_type = "VIDEO";
        params.video_url = item.url;
      }
      const child = await this.client.post<{ id: string }>(`${request.platformAccountId}/media`, params);
      childIds.push(child.id);
    }

    // Video children process asynchronously; the parent can't be created
    // until every child is FINISHED.
    for (const childId of childIds) {
      await this.waitForContainerReady(childId, request.accessToken);
    }

    const parent = await this.client.post<{ id: string }>(`${request.platformAccountId}/media`, {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      caption: request.caption,
      access_token: request.accessToken,
    });
    return parent.id;
  }

  /** Bounded polling — never loops forever, per the retry/safety requirements. */
  private async waitForContainerReady(containerId: string, accessToken: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt++) {
      const { status_code: status } = await this.client.get<{ status_code: ContainerStatus }>(containerId, {
        fields: "status_code",
        access_token: accessToken,
      });

      this.logger?.info({ containerId, status, attempt }, "instagram.container_status");

      switch (status) {
        case "FINISHED":
        case "PUBLISHED":
          return;
        case "ERROR":
          throw new PublishingError("CONTAINER_FAILED", "Instagram failed to process the media.");
        case "EXPIRED":
          throw new PublishingError(
            "CONTAINER_EXPIRED",
            "The Instagram media container expired before it could be published.",
          );
        case "IN_PROGRESS":
          break;
      }

      await sleep(this.pollIntervalMs);
    }

    throw new PublishingError(
      "CONTAINER_FAILED",
      "Instagram did not finish processing the media in time.",
      `Container ${containerId} still IN_PROGRESS after ${this.maxPollAttempts} polls`,
    );
  }

  /**
   * Current usage against Instagram's rolling 24-hour publishing limit.
   * Used as a pre-flight check so we fail fast instead of burning quota.
   */
  async getPublishingLimit(platformAccountId: string, accessToken: string): Promise<{ used: number; cap: number }> {
    const result = await this.client.get<{
      data?: { quota_usage?: number; config?: { quota_total?: number } }[];
    }>(`${platformAccountId}/content_publishing_limit`, {
      fields: "config,quota_usage",
      access_token: accessToken,
    });
    const entry = result.data?.[0];
    return { used: entry?.quota_usage ?? 0, cap: entry?.config?.quota_total ?? 100 };
  }

  // --- SocialPlatform surface ---

  /**
   * Kept for interface compatibility. PublishingService calls `publish()`
   * directly because publishing needs the richer request/outcome shape
   * (media kinds, resumable container, alt text).
   */
  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    throw new PublishingError(
      "PLATFORM_ERROR",
      "Use InstagramAdapter.publish() — the real adapter requires a full PublishPostRequest.",
      `Received legacy input for account ${input.socialAccountExternalId}`,
    );
  }

  async getPost(postId: string): Promise<SocialPost> {
    throw new PublishingError("PLATFORM_ERROR", "Reading Instagram posts is not implemented yet (Phase 5).", postId);
  }

  async getAnalytics(postId: string): Promise<PostAnalytics> {
    throw new PublishingError("PLATFORM_ERROR", "Instagram analytics are not implemented yet (Phase 5).", postId);
  }

  async getComments(postId: string): Promise<Comment[]> {
    throw new PublishingError("PLATFORM_ERROR", "Instagram comments are not implemented yet (Phase 6).", postId);
  }

  async replyToComment(input: ReplyInput): Promise<ReplyResult> {
    throw new PublishingError(
      "PLATFORM_ERROR",
      "Instagram comment replies are not implemented yet (Phase 6).",
      input.externalCommentId,
    );
  }
}
