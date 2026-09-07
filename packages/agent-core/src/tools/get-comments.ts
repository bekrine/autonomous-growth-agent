import type { SocialPlatformName } from "@agent/shared";
import type { Comment, SocialPlatformRegistry } from "@agent/social-platforms";
import type { Tool } from "../tool.js";

export interface GetCommentsInput {
  platform: SocialPlatformName;
  externalPostId: string;
}

export interface GetCommentsOutput {
  comments: Comment[];
}

export class GetCommentsTool implements Tool<GetCommentsInput, GetCommentsOutput> {
  readonly name = "getComments";
  readonly description = "Fetch comments on a published post.";

  constructor(private readonly platforms: SocialPlatformRegistry) {}

  async execute(input: GetCommentsInput) {
    const adapter = this.platforms.get(input.platform);
    const comments = await adapter.getComments(input.externalPostId);
    return { success: true, data: { comments } };
  }
}
