import type { SocialPlatformName } from "@agent/shared";
import { NotFoundError } from "@agent/shared";
import type { SocialPlatform } from "./types.js";
import { InstagramAdapter } from "./adapters/instagram-adapter.js";
import { FacebookAdapter } from "./adapters/facebook-adapter.js";

/**
 * Central lookup so callers ask for a platform by name instead of
 * importing concrete adapter classes — keeps agents/tools decoupled from
 * which platforms exist.
 */
export class SocialPlatformRegistry {
  private readonly adapters = new Map<SocialPlatformName, SocialPlatform>([
    ["instagram", new InstagramAdapter()],
    ["facebook", new FacebookAdapter()],
  ]);

  get(platform: SocialPlatformName): SocialPlatform {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new NotFoundError("SocialPlatform", platform);
    return adapter;
  }
}
