import type { SocialPlatformName } from "@agent/shared";
import type { PostAnalytics, SocialPlatformRegistry } from "@agent/social-platforms";
import type { Tool } from "../tool.js";

export interface GetPostAnalyticsInput {
  platform: SocialPlatformName;
  externalPostId: string;
}

export class GetPostAnalyticsTool implements Tool<GetPostAnalyticsInput, PostAnalytics> {
  readonly name = "getPostAnalytics";
  readonly description = "Fetch engagement analytics for a published post.";

  constructor(private readonly platforms: SocialPlatformRegistry) {}

  async execute(input: GetPostAnalyticsInput) {
    const adapter = this.platforms.get(input.platform);
    const data = await adapter.getAnalytics(input.externalPostId);
    return { success: true, data };
  }
}
