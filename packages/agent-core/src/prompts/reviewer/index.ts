import { buildReviewerSystemPrompt } from "./system.js";

export * from "./schema.js";

export interface ReviewerPromptContext {
  niche: string;
  targetAudience: string | null;
  positioning: string | null;
  objective: string | null;
  generatedContent: unknown;
  recentContentTitles: string[];
  researchTopics: { topic: string; rationale: string }[];
}

export function buildReviewerPrompt(context: ReviewerPromptContext): { systemPrompt: string; prompt: string } {
  return {
    systemPrompt: buildReviewerSystemPrompt(),
    prompt: JSON.stringify(context, null, 2),
  };
}
