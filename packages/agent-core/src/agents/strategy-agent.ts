import type { Agent, AgentContext, AgentResult } from "../types.js";

/**
 * Synthesizes a strategy summary from the research findings produced
 * earlier in the run. Persisting a new strategy_versions row is left to
 * the `updateStrategy` tool (gated by human approval) — this agent only
 * proposes.
 */
export class StrategyAgent implements Agent {
  readonly name = "strategy" as const;

  async run(context: AgentContext): Promise<AgentResult> {
    const research = context.previousResults.research?.data;

    const generated = await context.llm.generateText({
      systemPrompt: "You are a social-media growth strategist. Reply in one short sentence.",
      prompt: `Based on this research: ${JSON.stringify(research ?? {})}, propose a content strategy focus.`,
      maxTokens: 120,
    });

    return {
      decisions: [
        {
          decision: "strategy_proposed",
          reason: generated.text,
          metadata: { basedOnResearch: Boolean(research) },
        },
      ],
      actions: [
        {
          actionType: "proposeStrategy",
          status: "succeeded",
          result: { summary: generated.text },
        },
      ],
      data: { strategySummary: generated.text },
    };
  }
}
