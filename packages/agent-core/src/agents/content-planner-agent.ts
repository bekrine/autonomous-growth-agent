import type { Agent, AgentContext, AgentResult } from "../types.js";
import type { CreateContentBriefInput, CreateContentBriefOutput } from "../tools/create-content-brief.js";

/** Turns the proposed strategy into one or more concrete content ideas. */
export class ContentPlannerAgent implements Agent {
  readonly name = "content_planner" as const;

  async run(context: AgentContext): Promise<AgentResult> {
    const strategySummary = (context.previousResults.strategy?.data?.strategySummary as string) ?? "general growth";
    const ideaTitle = `Content idea aligned with: ${strategySummary.slice(0, 80)}`;

    const briefResult = await context.tools.call<CreateContentBriefInput, CreateContentBriefOutput>(
      "createContentBrief",
      context.accountId,
      { niche: strategySummary, ideaTitle },
    );

    return {
      decisions: [
        {
          decision: "content_idea_planned",
          reason: `Planned one content idea based on current strategy`,
          metadata: { ideaTitle },
        },
      ],
      actions: [
        {
          actionType: "createContentBrief",
          status: briefResult.success ? "succeeded" : "failed",
          result: briefResult.data,
        },
      ],
      data: { ideaTitle, brief: briefResult.data?.brief },
    };
  }
}
