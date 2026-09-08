import type { Agent, AgentContext, AgentResult } from "../types.js";
import {
  buildContentPlannerPrompt,
  ContentPlanResultSchema,
  type BuildContentPlannerPromptInput,
} from "../prompts/content-planner.prompt.js";
import type { ResearchResult } from "../prompts/research.prompt.js";
import type { StrategyResult } from "../prompts/strategy.prompt.js";

type StrategyForPrompt = BuildContentPlannerPromptInput["strategy"];

/** Turns the current strategy + fresh research into concrete content briefs (not finished posts). */
export class ContentPlannerAgent implements Agent {
  readonly name = "content_planner" as const;

  async run(context: AgentContext): Promise<AgentResult> {
    const strategyResult = context.previousResults.strategy?.data as
      | (StrategyResult & { shouldUpdateStrategy: boolean })
      | undefined;
    const freshResearch = (context.previousResults.research?.data?.topics as ResearchResult["topics"] | undefined) ?? [];

    const strategyForPrompt: StrategyForPrompt = strategyResult
      ? {
          positioning: strategyResult.positioning,
          audience: strategyResult.audience,
          contentPillars: strategyResult.contentPillars,
          formats: strategyResult.formats,
          postingFrequencyPerWeek: strategyResult.postingFrequencyPerWeek,
        }
      : context.currentStrategy
        ? {
            positioning: String(context.currentStrategy.data.positioning ?? ""),
            audience: String(context.currentStrategy.data.audience ?? ""),
            contentPillars: (context.currentStrategy.data.contentPillars as { name: string; weight: number }[]) ?? [],
            formats: (context.currentStrategy.data.formats as Record<string, number>) ?? {},
            postingFrequencyPerWeek: Number(context.currentStrategy.data.postingFrequencyPerWeek ?? 0),
          }
        : null;

    const { systemPrompt, prompt } = buildContentPlannerPrompt({
      niche: context.account.niche,
      targetAudience: context.account.targetAudience,
      strategy: strategyForPrompt,
      researchTopics: freshResearch.map((t) => ({ topic: t.topic, relevanceScore: t.relevanceScore })),
      recentContentTitles: context.recentContent.map((c) => c.title),
      activeExperiments: context.activeExperiments.map((e) => ({ name: e.name, hypothesis: e.hypothesis })),
    });

    const result = await context.llm.generateStructured({
      systemPrompt,
      prompt,
      schema: ContentPlanResultSchema,
      schemaName: "ContentPlanResult",
      runId: context.runId,
      agentName: this.name,
    });

    const pillarsCovered = [...new Set(result.ideas.map((i) => i.contentPillar))];
    const formatsCovered = new Set(result.ideas.map((i) => i.format));

    return {
      decisions: [
        {
          decision: "content_ideas_planned",
          reason: `Planned ${result.ideas.length} content idea(s) across ${formatsCovered.size} format(s) and ${pillarsCovered.length} content pillar(s).`,
          metadata: { ideaCount: result.ideas.length, pillarsCovered },
        },
      ],
      actions: [{ actionType: "generate_content_ideas", status: "succeeded", result }],
      data: { ideas: result.ideas },
    };
  }
}
