import { z } from "zod";

export const StrategyResultSchema = z.object({
  shouldUpdateStrategy: z.boolean(),
  audience: z.string().min(1),
  positioning: z.string().min(1),
  contentPillars: z
    .array(z.object({ name: z.string().min(1), weight: z.number().min(0).max(1) }))
    .min(1)
    .max(6),
  formats: z.record(z.string(), z.number().min(0).max(1)),
  postingFrequencyPerWeek: z.number().min(0).max(21),
  reasoningSummary: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export type StrategyResult = z.infer<typeof StrategyResultSchema>;

export interface BuildStrategyPromptInput {
  niche: string;
  targetAudience: string | null;
  goalTitle: string | null;
  currentStrategy: { versionNumber: number; summary: string; data: Record<string, unknown> } | null;
  previousVersionSummaries: string[];
  recentAnalyticsSummaries: string[];
  activeExperiments: { name: string; hypothesis: string | null }[];
  researchTopics: { topic: string; relevanceScore: number; rationale: string }[];
}

export function buildStrategyPrompt(input: BuildStrategyPromptInput): {
  systemPrompt: string;
  prompt: string;
} {
  const systemPrompt = [
    "You are the Strategy Agent in an autonomous social-media growth system.",
    "Decide what this account's content strategy should be, using ONLY the structured context you are given: goal, current strategy (if any), historical performance signals, active experiments, and fresh research.",
    "Do not replace the current strategy by default. Only set shouldUpdateStrategy to true when the evidence in the context justifies a change; otherwise return your best reconstruction of the current strategy with shouldUpdateStrategy: false.",
    "If currentStrategy is null, there is nothing to preserve — propose an initial strategy and set shouldUpdateStrategy to true.",
    "Never claim a performance pattern (e.g. 'recent posts show...') unless it is actually present in recentAnalyticsSummaries or previousVersionSummaries.",
    "Respond with ONLY a JSON object matching this exact shape, no prose, no markdown fences:",
    '{ "shouldUpdateStrategy": boolean, "audience": string, "positioning": string, "contentPillars": [ { "name": string, "weight": number 0-1 } ], "formats": { [format: string]: number 0-1 }, "postingFrequencyPerWeek": number, "reasoningSummary": string, "confidence": number 0-1 }',
    "contentPillars weights and formats values each represent a relative mix and do not need to sum to exactly 1.",
  ].join("\n");

  const prompt = JSON.stringify(
    {
      accountNiche: input.niche,
      targetAudience: input.targetAudience,
      goal: input.goalTitle,
      currentStrategy: input.currentStrategy,
      previousVersionSummaries: input.previousVersionSummaries,
      recentAnalyticsSummaries: input.recentAnalyticsSummaries,
      activeExperiments: input.activeExperiments,
      freshResearchTopics: input.researchTopics,
    },
    null,
    2,
  );

  return { systemPrompt, prompt };
}
