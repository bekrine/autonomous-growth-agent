import type { Agent, AgentContext, AgentResult } from "../types.js";
import {
  buildExperimentProposalPrompt,
  buildExperimentSummaryPrompt,
  ExperimentProposalSchema,
  ExperimentSummaryOutputSchema,
  type ExperimentProposal,
  type ExperimentProposalPromptInput,
  type ExperimentSummaryOutput,
  type ExperimentSummaryPromptInput,
} from "../prompts/experiment/index.js";

/**
 * Proposes experiment designs and explains completed results.
 *
 * Its boundaries mirror the AnalyticsAgent's:
 *
 *  1. It proposes; `ExperimentValidationService` decides. A proposal that
 *     violates the sample, concurrency or confounder rules is rejected by
 *     ordinary code no matter how confident the model was.
 *  2. It never computes a statistic. Outcome, lift and confidence are given to
 *     it already computed; it only puts them into words.
 *  3. It never changes strategy. Its output has a `recommendation` field, which
 *     is explicitly a suggestion for a human — Phase 7 owns acting on it.
 */
export class ExperimentAgent implements Agent {
  readonly name = "experiment" as const;

  async run(context: AgentContext): Promise<AgentResult> {
    const input = context.experimentInput;

    if (!input) {
      return {
        decisions: [
          {
            decision: "no_experiment_task",
            reason: "No experiment proposal or summary was requested for this run.",
          },
        ],
        actions: [],
      };
    }

    return input.mode === "summarize"
      ? this.summarize(context, input.summary)
      : this.propose(context, input.proposal);
  }

  private async propose(context: AgentContext, promptInput: ExperimentProposalPromptInput): Promise<AgentResult> {
    const { systemPrompt, prompt } = buildExperimentProposalPrompt(promptInput);

    const proposal = await context.llm.generateStructured<ExperimentProposal>({
      systemPrompt,
      prompt,
      schema: ExperimentProposalSchema,
      schemaName: "ExperimentProposal",
    });

    // Confidence is capped by how much evidence actually exists, for the same
    // reason the AnalyticsAgent clamps it: a model asked to stay humble will
    // still sometimes propose a 0.9 from three posts.
    const guarded: ExperimentProposal = {
      ...proposal,
      confidence: promptInput.postCount < 5 ? Math.min(proposal.confidence, 0.4) : proposal.confidence,
    };

    return {
      decisions: [
        {
          decision: "experiment_proposal",
          reason: guarded.rationale,
          metadata: {
            variable: guarded.variable,
            primaryMetric: guarded.primaryMetric,
            control: guarded.control.variableValue,
            variant: guarded.variant.variableValue,
            confidence: guarded.confidence,
            hypothesis: guarded.hypothesis,
            evidencePostCount: promptInput.postCount,
          },
        },
      ],
      actions: [],
      data: { proposal: guarded },
    };
  }

  private async summarize(context: AgentContext, promptInput: ExperimentSummaryPromptInput): Promise<AgentResult> {
    const { systemPrompt, prompt } = buildExperimentSummaryPrompt(promptInput);

    const summary: ExperimentSummaryOutput = await context.llm.generateStructured<ExperimentSummaryOutput>({
      systemPrompt,
      prompt,
      schema: ExperimentSummaryOutputSchema,
      schemaName: "ExperimentSummary",
    });

    return {
      decisions: [
        {
          decision: "experiment_summary",
          reason: summary.summary,
          metadata: {
            // The computed verdict is recorded alongside the narrative, so the
            // audit trail shows what the engine decided, not just what the
            // model said about it.
            outcome: promptInput.outcome,
            confidence: promptInput.confidence,
            primaryMetric: promptInput.primaryMetric,
            sampleSizes: promptInput.sampleSizes,
            recommendation: summary.recommendation,
            caveats: summary.caveats,
          },
        },
      ],
      actions: [],
      data: { summary },
    };
  }
}
