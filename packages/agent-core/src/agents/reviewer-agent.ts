import type { Agent, AgentContext, AgentResult } from "../types.js";
import { buildReviewerPrompt, ReviewResultSchema } from "../prompts/reviewer/index.js";
import { MissingContentGenerationContextError } from "../errors.js";

/**
 * Evaluates the content ContentCreatorAgent just produced against quality,
 * brand consistency, safety, accuracy, duplication and platform-readiness
 * checks. Never rewrites content and never invents verification for a
 * claim it cannot check — it only judges and explains. The orchestrator
 * decides what happens next (approve vs. trigger a regeneration attempt)
 * based on this agent's `approved` verdict.
 */
export class ReviewerAgent implements Agent {
  readonly name = "reviewer" as const;

  async run(context: AgentContext): Promise<AgentResult> {
    const generatedContent = context.previousResults.content_creator?.data?.generatedContent;
    if (!generatedContent) {
      throw new MissingContentGenerationContextError(
        "ReviewerAgent requires previousResults.content_creator.data.generatedContent — it must run immediately after ContentCreatorAgent in the same call.",
      );
    }

    const strategyData = context.previousResults.strategy?.data as { positioning?: string } | undefined;
    const positioning = strategyData?.positioning ?? (context.currentStrategy?.data.positioning as string | undefined) ?? null;

    const { systemPrompt, prompt } = buildReviewerPrompt({
      niche: context.account.niche,
      targetAudience: context.account.targetAudience,
      positioning,
      objective: context.targetContentIdea?.objective ?? null,
      generatedContent,
      recentContentTitles: context.recentContent.map((c) => c.title),
      researchTopics: context.research.map((r) => ({ topic: r.topic, rationale: "" })),
    });

    const result = await context.llm.generateStructured({
      systemPrompt,
      prompt,
      schema: ReviewResultSchema,
      schemaName: "ReviewResult",
      runId: context.runId,
      agentName: this.name,
    });

    return {
      decisions: [
        {
          decision: result.approved ? "content_approved" : "content_rejected",
          reason:
            result.issues[0]?.message ??
            (result.approved ? "Content meets the quality/brand/safety bar." : "Content did not meet the required bar."),
          metadata: {
            score: result.score,
            qualityScore: result.qualityScore,
            brandScore: result.brandScore,
            safetyScore: result.safetyScore,
            issueCount: result.issues.length,
          },
        },
      ],
      actions: [{ actionType: "review_content", status: "succeeded", result }],
      data: { review: result },
    };
  }
}
