import type { Policy, PolicyContext, PolicyResult } from "../types.js";

const ACTIONS_REQUIRING_HUMAN_APPROVAL = new Set(["update_strategy", "delete_content"]);

/**
 * Flags high-impact action types that must be approved by a human before
 * execution, regardless of what upstream agents decided. The tool router
 * is expected to short-circuit and create a pending-approval record rather
 * than executing when this denies.
 */
export class HumanApprovalPolicy implements Policy {
  readonly name = "human-approval-required";

  evaluate(context: PolicyContext): PolicyResult {
    if (!ACTIONS_REQUIRING_HUMAN_APPROVAL.has(context.actionType)) {
      return { allowed: true };
    }
    if (context.payload.humanApproved === true) {
      return { allowed: true };
    }
    return { allowed: false, reason: `Action "${context.actionType}" requires human approval` };
  }
}
