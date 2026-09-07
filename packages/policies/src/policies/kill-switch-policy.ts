import type { KillSwitchStore } from "../kill-switch.js";
import type { Policy, PolicyContext, PolicyResult } from "../types.js";

export class KillSwitchPolicy implements Policy {
  readonly name = "kill-switch";

  constructor(private readonly killSwitch: KillSwitchStore) {}

  evaluate(context: PolicyContext): PolicyResult {
    if (this.killSwitch.isGloballyDisabled()) {
      return { allowed: false, reason: "Global autonomy kill switch is enabled" };
    }
    if (this.killSwitch.isAccountDisabled(context.accountId)) {
      return { allowed: false, reason: `Autonomy is disabled for account ${context.accountId}` };
    }
    return { allowed: true };
  }
}
