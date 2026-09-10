import type { Logger, SocialPlatformName } from "@agent/shared";
import { NotFoundError } from "@agent/shared";
import type { SocialPlatform } from "./types.js";
import { InstagramAdapter } from "./adapters/instagram/instagram-adapter.js";
import { MockInstagramAdapter } from "./adapters/instagram/mock-instagram-adapter.js";
import type { PublishingPlatform } from "./adapters/instagram/publishing-platform.js";
import { FacebookAdapter } from "./adapters/facebook-adapter.js";

export interface SocialPlatformRegistryOptions {
  /**
   * When false (the default), Instagram resolves to MockInstagramAdapter so
   * nothing can reach Meta or publish to a real account by accident.
   */
  instagramPublishingEnabled?: boolean;
  metaApiVersion?: string;
  metaGraphHost?: string;
  logger?: Logger;
}

/**
 * Central lookup so callers ask for a platform by name instead of
 * importing concrete adapter classes — keeps agents/tools decoupled from
 * which platforms exist, and from whether the real or mock Instagram
 * implementation is active.
 */
export class SocialPlatformRegistry {
  private readonly adapters: Map<SocialPlatformName, SocialPlatform>;
  private readonly publishers: Map<SocialPlatformName, PublishingPlatform>;

  constructor(options: SocialPlatformRegistryOptions = {}) {
    const instagram: SocialPlatform & PublishingPlatform = options.instagramPublishingEnabled
      ? (new InstagramAdapter({
          apiVersion: options.metaApiVersion ?? "v21.0",
          host: options.metaGraphHost ?? "https://graph.facebook.com",
          logger: options.logger,
        }) as SocialPlatform & PublishingPlatform)
      : new MockInstagramAdapter();

    this.adapters = new Map<SocialPlatformName, SocialPlatform>([
      ["instagram", instagram],
      ["facebook", new FacebookAdapter()],
    ]);
    this.publishers = new Map<SocialPlatformName, PublishingPlatform>([["instagram", instagram]]);
  }

  get(platform: SocialPlatformName): SocialPlatform {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new NotFoundError("SocialPlatform", platform);
    return adapter;
  }

  /** Publishing-capable adapter. Facebook publishing is not implemented in this phase. */
  getPublisher(platform: SocialPlatformName): PublishingPlatform {
    const publisher = this.publishers.get(platform);
    if (!publisher) throw new NotFoundError("PublishingPlatform", platform);
    return publisher;
  }
}
