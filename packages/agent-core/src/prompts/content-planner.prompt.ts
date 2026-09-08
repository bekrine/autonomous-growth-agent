import { z } from "zod";

export const ContentIdeaSchema = z.object({
  title: z.string().min(1),
  format: z.string().min(1),
  contentPillar: z.string().min(1),
  targetAudience: z.string().min(1),
  hook: z.string().min(1),
  objective: z.string().min(1),
  priorityScore: z.number().min(0).max(1),
});

export const ContentPlanResultSchema = z.object({
  ideas: z.array(ContentIdeaSchema).min(3).max(12),
});

export type ContentPlanResult = z.infer<typeof ContentPlanResultSchema>;

export interface BuildContentPlannerPromptInput {
  niche: string;
  targetAudience: string | null;
  strategy: {
    positioning: string;
    audience: string;
    contentPillars: { name: string; weight: number }[];
    formats: Record<string, number>;
    postingFrequencyPerWeek: number;
  } | null;
  researchTopics: { topic: string; relevanceScore: number }[];
  recentContentTitles: string[];
  activeExperiments: { name: string; hypothesis: string | null }[];
}

export function buildContentPlannerPrompt(input: BuildContentPlannerPromptInput): {
  systemPrompt: string;
  prompt: string;
} {
  const systemPrompt = [
    "You are the Content Planner Agent in an autonomous social-media growth system.",
    "Convert the current strategy and research topics into concrete content BRIEFS (ideas) — not finished captions or scripts.",
    "Ground every idea in the given strategy's contentPillars/formats/audience and in the given research topics — do not invent pillars or topics that are not present in the context.",
    "recentContentTitles lists ideas/posts already produced — do not propose a near-duplicate of any of them.",
    "Vary topic, format, hook and objective across the ideas you return so the set is useful for experimentation, not 10 versions of the same idea.",
    "Respond with ONLY a JSON object matching this exact shape, no prose, no markdown fences:",
    '{ "ideas": [ { "title": string, "format": string, "contentPillar": string, "targetAudience": string, "hook": string, "objective": string, "priorityScore": number 0-1 } ] }',
    "Return 3 to 12 ideas.",
  ].join("\n");

  const prompt = JSON.stringify(
    {
      accountNiche: input.niche,
      targetAudience: input.targetAudience,
      strategy: input.strategy,
      researchTopics: input.researchTopics,
      recentContentTitles: input.recentContentTitles,
      activeExperiments: input.activeExperiments,
    },
    null,
    2,
  );

  return { systemPrompt, prompt };
}
