import type { SocialPlatformName } from "@agent/shared";
import type { SocialPlatformRegistry } from "@agent/social-platforms";
import type { Tool } from "../tool.js";

export interface PublishPostToolInput {
  platform: SocialPlatformName;
  socialAccountExternalId: string;
  caption: string;
  mediaUrls: string[];
  /** Read by ContentApprovalPolicy before this tool ever runs. */
  contentStatus: string;
}

export interface PublishPostToolOutput {
  externalPostId: string;
  publishedAt: string;
}

export class PublishPostTool implements Tool<PublishPostToolInput, PublishPostToolOutput> {
  readonly name = "publishPost";
  readonly description = "Publish an approved post to a social platform.";

  constructor(private readonly platforms: SocialPlatformRegistry) {}

  async execute(input: PublishPostToolInput) {
    const adapter = this.platforms.get(input.platform);
    const result = await adapter.publishPost({
      socialAccountExternalId: input.socialAccountExternalId,
      caption: input.caption,
      mediaUrls: input.mediaUrls,
    });
    return { success: true, data: result };
  }
}
