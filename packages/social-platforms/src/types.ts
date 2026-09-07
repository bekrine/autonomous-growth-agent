import type { SocialPlatformName } from "@agent/shared";

/** Generic, platform-agnostic content payload. No Instagram/Facebook-specific fields. */
export interface PublishPostInput {
  socialAccountExternalId: string;
  caption: string;
  mediaUrls: string[];
}

export interface PublishResult {
  externalPostId: string;
  publishedAt: string;
}

export interface SocialPost {
  externalPostId: string;
  caption: string;
  mediaUrls: string[];
  createdAt: string;
}

export interface PostAnalytics {
  externalPostId: string;
  likes: number;
  comments: number;
  shares: number;
  impressions: number;
  capturedAt: string;
}

export interface Comment {
  externalCommentId: string;
  authorName: string;
  text: string;
  createdAt: string;
}

export interface ReplyInput {
  externalCommentId: string;
  text: string;
}

export interface ReplyResult {
  externalReplyId: string;
}

/**
 * Every platform integration implements this interface. Agents/tools call
 * only these methods — no Instagram/Facebook SDK code may appear outside
 * packages/social-platforms/src/adapters.
 */
export interface SocialPlatform {
  readonly platform: SocialPlatformName;
  publishPost(input: PublishPostInput): Promise<PublishResult>;
  getPost(postId: string): Promise<SocialPost>;
  getAnalytics(postId: string): Promise<PostAnalytics>;
  getComments(postId: string): Promise<Comment[]>;
  replyToComment(input: ReplyInput): Promise<ReplyResult>;
}
