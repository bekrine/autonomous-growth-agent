import type { Agent, AgentContext, AgentResult } from "../types.js";

/**
 * Shared skeleton for agents not yet wired into the orchestrator. Each
 * records a single "not_implemented" decision so the run history stays
 * consistent once these are invoked, and gives a single place to flesh
 * out real behavior later without changing the Agent contract.
 */
abstract class SkeletonAgent implements Agent {
  abstract readonly name: Agent["name"];

  async run(_context: AgentContext): Promise<AgentResult> {
    return {
      decisions: [
        {
          decision: "not_implemented",
          reason: `${this.name} agent is a placeholder in this phase of the foundation`,
        },
      ],
      actions: [],
    };
  }
}

export class AnalyticsAgent extends SkeletonAgent {
  readonly name = "analytics" as const;
}

export class ExperimentAgent extends SkeletonAgent {
  readonly name = "experiment" as const;
}

export class CommunityAgent extends SkeletonAgent {
  readonly name = "community" as const;
}
