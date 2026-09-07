import type { StrategyRepository } from "@agent/database";
import type { Tool } from "../tool.js";

export interface GetStrategyInput {
  agentProfileId: string;
}

export interface GetStrategyOutput {
  strategyId: string | null;
  summary: string | null;
  content: Record<string, unknown> | null;
}

export class GetStrategyTool implements Tool<GetStrategyInput, GetStrategyOutput> {
  readonly name = "getStrategy";
  readonly description = "Load the current strategy for an agent profile, if any exists.";

  constructor(private readonly repo: StrategyRepository) {}

  async execute(input: GetStrategyInput) {
    const strategies = await this.repo.findByAgentProfileId(input.agentProfileId);
    const strategy = strategies[0];
    if (!strategy) {
      return { success: true, data: { strategyId: null, summary: null, content: null } };
    }
    const version = await this.repo.latestVersion(strategy.id);
    return {
      success: true,
      data: {
        strategyId: strategy.id,
        summary: version?.summary ?? null,
        content: (version?.content as Record<string, unknown>) ?? null,
      },
    };
  }
}
