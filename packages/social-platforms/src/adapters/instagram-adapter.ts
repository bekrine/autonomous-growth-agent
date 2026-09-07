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
} from "../types.js";

/**
 * Placeholder adapter. Real implementation will call the Instagram Graph
 * API; for now it returns deterministic stub data so the rest of the
 * system (agents, tools, policies, queues) can be built and tested against
 * a stable contract before real credentials exist.
 */
export class InstagramAdapter implements SocialPlatform {
  readonly platform = "instagram" as const;

  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    return {
      externalPostId: `ig_${generateId()}`,
      publishedAt: new Date().toISOString(),
    };
  }

  async getPost(postId: string): Promise<SocialPost> {
    return {
      externalPostId: postId,
      caption: "[stub] Instagram post caption",
      mediaUrls: [],
      createdAt: new Date().toISOString(),
    };
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
    return { externalReplyId: `ig_reply_${generateId()}` };
  }
}
