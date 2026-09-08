import type { Agent, AgentContext, AgentResult } from "../types.js";
import { buildStrategyPrompt, StrategyResultSchema, type StrategyResult } from "../prompts/strategy.prompt.js";
import type { ResearchResult } from "../prompts/research.prompt.js";

/**
 * Decides whether the account's content strategy should change, weighing
 * the current strategy against historical performance, active experiments
 * and fresh research — it does not replace the strategy on every run.
 * Persisting a new strategy_versions row happens outside the agent (in the
 * orchestrator, via StrategyRepository); this agent only decides and
 * returns structured data.
 */
export class StrategyAgent implements Agent {
  readonly name = "strategy" as const;

  async run(context: AgentContext): Promise<AgentResult> {
    const freshResearch = (context.previousResults.research?.data?.topics as ResearchResult["topics"] | undefined) ?? [];

    const { systemPrompt, prompt } = buildStrategyPrompt({
      niche: context.account.niche,
      targetAudience: context.account.targetAudience,
      goalTitle: context.goal?.title ?? null,
      currentStrategy: context.currentStrategy
        ? {
            versionNumber: context.currentStrategy.versionNumber,
            summary: context.currentStrategy.summary,
            data: context.currentStrategy.data,
          }
        : null,
      previousVersionSummaries: context.previousStrategyVersions.map((v) => `v${v.versionNumber}: ${v.summary}`),
      recentAnalyticsSummaries: context.recentAnalytics.map(
        (a) => `${a.metricType} @ ${a.capturedAt}: ${JSON.stringify(a.metrics)}`,
      ),
      activeExperiments: context.activeExperiments.map((e) => ({ name: e.name, hypothesis: e.hypothesis })),
      researchTopics: freshResearch.map((t) => ({
        topic: t.topic,
        relevanceScore: t.relevanceScore,
        rationale: t.rationale,
      })),
    });

    const result = await context.llm.generateStructured<StrategyResult>({
      systemPrompt,
      prompt,
      schema: StrategyResultSchema,
      schemaName: "StrategyResult",
      runId: context.runId,
      agentName: this.name,
    });

    // No existing strategy means there is nothing to preserve — always
    // materialize an initial version regardless of what the model returned.
    const noExistingStrategy = context.currentStrategy === null;
    const shouldUpdateStrategy = noExistingStrategy || result.shouldUpdateStrategy;

    return {
      decisions: [
        {
          decision: shouldUpdateStrategy ? "strategy_updated" : "strategy_unchanged",
          reason: result.reasoningSummary,
          metadata: {
            confidence: result.confidence,
            contentPillars: result.contentPillars.map((p) => p.name),
            forcedInitialVersion: noExistingStrategy,
          },
        },
      ],
      actions: [
        {
          actionType: shouldUpdateStrategy ? "create_strategy_version" : "evaluate_strategy",
          status: "succeeded",
          result,
        },
      ],
      data: { ...result, shouldUpdateStrategy },
    };
  }
}
