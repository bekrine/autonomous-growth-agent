import type { StrategyRepository } from "@agent/database";
import type { Tool } from "../tool.js";

export interface UpdateStrategyInput {
  strategyId: string;
  versionNumber: number;
  summary: string;
  content: Record<string, unknown>;
  createdBy: string;
  /** Checked by HumanApprovalPolicy before this tool ever runs. */
  humanApproved: boolean;
}

export interface UpdateStrategyOutput {
  versionId: string;
}

export class UpdateStrategyTool implements Tool<UpdateStrategyInput, UpdateStrategyOutput> {
  readonly name = "updateStrategy";
  readonly description = "Create a new strategy version and make it current (requires human approval).";

  constructor(private readonly repo: StrategyRepository) {}

  async execute(input: UpdateStrategyInput) {
    const version = await this.repo.createVersion({
      strategyId: input.strategyId,
      versionNumber: input.versionNumber,
      summary: input.summary,
      content: input.content,
      createdBy: input.createdBy,
    });
    return { success: true, data: { versionId: version.id } };
  }
}
