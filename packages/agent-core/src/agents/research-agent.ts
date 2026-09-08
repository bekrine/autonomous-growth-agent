import type { Agent, AgentContext, AgentResult } from "../types.js";
import type { ResearchProvider } from "../research/research-provider.js";
import { buildResearchPrompt, ResearchResultSchema } from "../prompts/research.prompt.js";

/**
 * Identifies content opportunities for the account from its niche,
 * audience, goal, current strategy, recent content and research signals.
 * The research source is injected (`ResearchProvider`) so a real
 * web/trend/social provider can replace `MockResearchProvider` later
 * without this agent changing.
 */
export class ResearchAgent implements Agent {
  readonly name = "research" as const;

  constructor(private readonly researchProvider: ResearchProvider) {}

  async run(context: AgentContext): Promise<AgentResult> {
    const priorTopics = context.research.map((r) => r.topic);

    const signals = await this.researchProvider.discoverTopics({
      niche: context.account.niche,
      targetAudience: context.account.targetAudience,
      excludeTopics: priorTopics,
    });

    const { systemPrompt, prompt } = buildResearchPrompt({
      niche: context.account.niche,
      targetAudience: context.account.targetAudience,
      goalTitle: context.goal?.title ?? null,
      strategySummary: context.currentStrategy?.summary ?? null,
      recentContentTitles: context.recentContent.map((c) => c.title),
      priorResearchTopics: priorTopics,
      signals: signals.map((s) => ({
        topic: s.topic,
        signalStrength: s.signalStrength,
        sourceType: s.sourceType,
      })),
    });

    const result = await context.llm.generateStructured({
      systemPrompt,
      prompt,
      schema: ResearchResultSchema,
      schemaName: "ResearchResult",
      runId: context.runId,
      agentName: this.name,
    });

    const allSimulated = signals.length === 0 || signals.every((s) => s.sourceType === "mock");

    return {
      decisions: [
        {
          decision: "research_topics_discovered",
          reason: `Identified ${result.topics.length} candidate topic(s) from ${signals.length} research signal(s) via the "${this.researchProvider.name}" provider.`,
          metadata: {
            topicCount: result.topics.length,
            topTopics: result.topics.slice(0, 3).map((t) => t.topic),
            simulatedSource: allSimulated,
          },
        },
      ],
      actions: [
        {
          actionType: "research_topics",
          status: "succeeded",
          payload: { signalCount: signals.length, provider: this.researchProvider.name },
          result,
        },
      ],
      data: { topics: result.topics },
    };
  }
}
