import { z } from "zod";

export const ResearchTopicSchema = z.object({
  topic: z.string().min(1),
  relevanceScore: z.number().min(0).max(1),
  audienceInterestScore: z.number().min(0).max(1),
  competitionScore: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

export const ResearchResultSchema = z.object({
  topics: z.array(ResearchTopicSchema).min(1).max(8),
});

export type ResearchResult = z.infer<typeof ResearchResultSchema>;

export interface BuildResearchPromptInput {
  niche: string;
  targetAudience: string | null;
  goalTitle: string | null;
  strategySummary: string | null;
  recentContentTitles: string[];
  priorResearchTopics: string[];
  signals: { topic: string; signalStrength: number; sourceType: string }[];
}

/**
 * Static role/instructions are kept separate from the dynamic account
 * context (rendered as a compact JSON block) so the system prompt never
 * needs to be regenerated per account, and the dynamic half stays
 * inspectable/loggable on its own.
 */
export function buildResearchPrompt(input: BuildResearchPromptInput): {
  systemPrompt: string;
  prompt: string;
} {
  const systemPrompt = [
    "You are the Research Agent in an autonomous social-media growth system.",
    "Identify content opportunities for one account using ONLY the structured context you are given below — never invent facts about the account's history, and never present a 'researchSignals' entry with simulated:true as a verified real-world trend.",
    "When a research signal is simulated, you may still use it as an illustrative candidate topic, but say so plainly in the rationale if you build on it.",
    "Respond with ONLY a JSON object matching this exact shape, no prose, no markdown fences:",
    '{ "topics": [ { "topic": string, "relevanceScore": number 0-1, "audienceInterestScore": number 0-1, "competitionScore": number 0-1, "rationale": string } ] }',
    "Return 3 to 8 topics. Each rationale must be one concise sentence grounded in the given context, not a generic platitude.",
  ].join("\n");

  const prompt = JSON.stringify(
    {
      accountNiche: input.niche,
      targetAudience: input.targetAudience,
      goal: input.goalTitle,
      currentStrategySummary: input.strategySummary,
      recentContentTitles: input.recentContentTitles,
      topicsAlreadyCoveredRecently: input.priorResearchTopics,
      researchSignals: input.signals.map((s) => ({
        topic: s.topic,
        signalStrength: s.signalStrength,
        simulated: s.sourceType === "mock",
      })),
    },
    null,
    2,
  );

  return { systemPrompt, prompt };
}
