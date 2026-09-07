import type { SocialPlatformName } from "@agent/shared";
import { SOCIAL_PLATFORMS } from "@agent/shared";
import type { Policy, PolicyContext, PolicyResult } from "../types.js";

export class PlatformAvailabilityPolicy implements Policy {
  readonly name = "platform-availability";

  evaluate(context: PolicyContext): PolicyResult {
    const platform = context.payload.platform as SocialPlatformName | undefined;
    if (!platform) return { allowed: true };
    if (!SOCIAL_PLATFORMS.includes(platform)) {
      return { allowed: false, reason: `Platform "${platform}" is not supported` };
    }
    return { allowed: true };
  }
}
