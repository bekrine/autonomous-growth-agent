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

/** Placeholder adapter — see InstagramAdapter for the rationale. */
export class FacebookAdapter implements SocialPlatform {
  readonly platform = "facebook" as const;

  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    return {
      externalPostId: `fb_${generateId()}`,
      publishedAt: new Date().toISOString(),
    };
  }

  async getPost(postId: string): Promise<SocialPost> {
    return {
      externalPostId: postId,
      caption: "[stub] Facebook post caption",
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
    return { externalReplyId: `fb_reply_${generateId()}` };
  }
}
