import type { Policy, PolicyContext, PolicyResult } from "./types.js";

/**
 * Sits between the tool router and tool execution:
 *   Agent -> Tool Router -> PolicyEngine -> Tool Execution
 * Every registered policy must allow for the engine to allow. The first
 * denial short-circuits and its reason is surfaced to the caller.
 */
export class PolicyEngine {
  constructor(private readonly policies: Policy[]) {}

  async evaluate(context: PolicyContext): Promise<PolicyResult> {
    for (const policy of this.policies) {
      const result = await policy.evaluate(context);
      if (!result.allowed) {
        return { allowed: false, reason: `[${policy.name}] ${result.reason ?? "denied"}` };
      }
    }
    return { allowed: true };
  }
}
