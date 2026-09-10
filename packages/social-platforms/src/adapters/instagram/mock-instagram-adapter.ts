import { generateId } from "@agent/shared";
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
import type { PublishingPlatform } from "./publishing-platform.js";

/**
 * Deterministic stand-in for InstagramAdapter. Used whenever
 * INSTAGRAM_PUBLISHING_ENABLED is false and by the whole automated test
 * suite, so no test can ever hit Meta or publish to a real account.
 *
 * It exercises the same container -> publish shape (including the
 * onContainerCreated callback) so idempotency/resume logic is genuinely
 * covered rather than bypassed.
 */
export class MockInstagramAdapter implements SocialPlatform, PublishingPlatform {
  readonly platform = "instagram" as const;

  /** Every publish this instance performed — lets tests assert no duplicates. */
  readonly publishedPosts: { containerId: string; externalPostId: string; caption: string }[] = [];

  constructor(
    private readonly options: {
      /** Force a specific failure to exercise retry/permanent-failure paths. */
      failWith?: PublishingError;
      /** Simulate a resumed attempt finding its container already published. */
      simulateSlowContainer?: boolean;
    } = {},
  ) {}

  async publish(request: PublishPostRequest): Promise<PublishPostOutcome> {
    if (this.options.failWith) throw this.options.failWith;

    if (request.kind === "text") {
      throw new PublishingError("MEDIA_INVALID", "Instagram requires media; text-only content cannot be published.");
    }
    if (request.media.length === 0) {
      throw new PublishingError("MEDIA_INVALID", "No media supplied for an Instagram post.");
    }

    const containerId = request.existingContainerId ?? `mock_container_${generateId()}`;
    if (!request.existingContainerId) {
      await request.onContainerCreated?.(containerId);
    }

    const externalPostId = `mock_ig_media_${generateId()}`;
    this.publishedPosts.push({ containerId, externalPostId, caption: request.caption });

    return { externalPostId, externalContainerId: containerId, publishedAt: new Date().toISOString() };
  }

  async getPublishingLimit(): Promise<{ used: number; cap: number }> {
    return { used: this.publishedPosts.length, cap: 100 };
  }

  async publishPost(_input: PublishPostInput): Promise<PublishResult> {
    throw new PublishingError("PLATFORM_ERROR", "Use MockInstagramAdapter.publish().");
  }

  async getPost(postId: string): Promise<SocialPost> {
    return { externalPostId: postId, caption: "[mock] caption", mediaUrls: [], createdAt: new Date().toISOString() };
  }

  async getAnalytics(postId: string): Promise<PostAnalytics> {
    return {
      externalPostId: postId,
      likes: 0,
      comments: 0,
      shares: 0,
      impressions: 0,
      capturedAt: new Date().toISOString(),
    };
  }

  async getComments(_postId: string): Promise<Comment[]> {
    return [];
  }

  async replyToComment(_input: ReplyInput): Promise<ReplyResult> {
    return { externalReplyId: `mock_ig_reply_${generateId()}` };
  }
}
