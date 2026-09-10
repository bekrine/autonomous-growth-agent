import type { Agent, AgentContext, AgentResult } from "../types.js";
import {
  buildContentCreatorPrompt,
  CONTENT_SCHEMA_BY_FORMAT,
  normalizeContentFormat,
  type GeneratedContent,
} from "../prompts/content-creator/index.js";
import { MissingContentGenerationContextError } from "../errors.js";

/**
 * Transforms one approved content idea + the account's strategy into a
 * complete, structured content package (hook, script/body, caption, CTA,
 * keywords, visual direction, alt text) — never a finished/published post.
 * Media generation and review happen outside this agent (orchestrator +
 * ReviewerAgent respectively); this agent only produces the creative spec.
 */
export class ContentCreatorAgent implements Agent {
  readonly name = "content_creator" as const;

  async run(context: AgentContext): Promise<AgentResult> {
    if (!context.targetContentIdea) {
      throw new MissingContentGenerationContextError(
        "ContentCreatorAgent requires context.targetContentIdea — it must run as part of a content-generation call, not an account-level run.",
      );
    }

    const idea = context.targetContentIdea;
    const format = normalizeContentFormat(idea.format);

    const strategyData = context.previousResults.strategy?.data as
      | { positioning?: string; contentPillars?: { name: string; weight: number }[] }
      | undefined;
    const positioning = strategyData?.positioning ?? (context.currentStrategy?.data.positioning as string | undefined) ?? null;
    const contentPillars =
      strategyData?.contentPillars ?? (context.currentStrategy?.data.contentPillars as { name: string; weight: number }[] | undefined) ?? [];

    const { systemPrompt, prompt } = buildContentCreatorPrompt(format, {
      niche: context.account.niche,
      targetAudience: context.account.targetAudience,
      positioning,
      contentPillars,
      ideaTitle: idea.title,
      ideaHook: idea.hook,
      ideaContentPillar: idea.contentPillar,
      ideaObjective: idea.objective,
      recentContentTitles: context.recentContent.map((c) => c.title),
      researchTopics: context.research.map((r) => ({ topic: r.topic, rationale: "" })),
      activeExperiments: context.activeExperiments.map((e) => ({ name: e.name, hypothesis: e.hypothesis })),
      regenerationFeedback: context.regenerationFeedback,
    });

    const result = await context.llm.generateStructured<GeneratedContent>({
      systemPrompt,
      prompt,
      schema: CONTENT_SCHEMA_BY_FORMAT[format],
      schemaName: `GeneratedContent(${format})`,
      runId: context.runId,
      agentName: this.name,
    });

    return {
      decisions: [
        {
          decision: "content_generated",
          reason: `Generated ${format} content for "${idea.title}": "${result.title}"`,
          metadata: {
            format,
            keywordCount: result.keywords.length,
            hasContentWarnings: result.contentWarnings.length > 0,
            regenerated: context.regenerationFeedback.length > 0,
          },
        },
      ],
      actions: [{ actionType: "generate_content", status: "succeeded", result }],
      data: { generatedContent: result },
    };
  }
}
