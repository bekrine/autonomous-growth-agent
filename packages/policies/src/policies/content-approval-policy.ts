import type { Policy, PolicyContext, PolicyResult } from "../types.js";

/**
 * Publishing actions must reference content that has already been marked
 * approved by a ReviewerAgent (or a human). Expects `payload.contentStatus`
 * to be set by the caller (the publish tool loads the post's status before
 * invoking the policy check).
 */
export class ContentApprovalPolicy implements Policy {
  readonly name = "content-approval";

  evaluate(context: PolicyContext): PolicyResult {
    if (context.actionType !== "publish_post") {
      return { allowed: true };
    }
    const status = context.payload.contentStatus;
    if (status !== "approved" && status !== "scheduled") {
      return { allowed: false, reason: `Content is not approved for publishing (status: ${status})` };
    }
    return { allowed: true };
  }
}
