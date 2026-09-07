export interface PolicyContext {
  accountId: string;
  actionType: string;
  payload: Record<string, unknown>;
}

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

/**
 * A single, independently testable rule. The PolicyEngine runs every
 * registered policy for an action and denies if any of them deny —
 * agents/tools can never bypass this by calling a platform adapter directly.
 */
export interface Policy {
  readonly name: string;
  evaluate(context: PolicyContext): Promise<PolicyResult> | PolicyResult;
}
