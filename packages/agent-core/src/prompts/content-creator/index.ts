import type { ContentFormat } from "./schema.js";
import { buildContentCreatorSystemPrompt } from "./system.js";
import { buildReelInstructions } from "./reel.js";
import { buildCarouselInstructions } from "./carousel.js";
import { buildImageInstructions } from "./image.js";
import { buildTextInstructions } from "./text.js";

export * from "./schema.js";

const FORMAT_INSTRUCTIONS: Record<ContentFormat, () => string> = {
  reel: buildReelInstructions,
  carousel: buildCarouselInstructions,
  image: buildImageInstructions,
  text: buildTextInstructions,
};

export interface ContentCreatorPromptContext {
  niche: string;
  targetAudience: string | null;
  positioning: string | null;
  contentPillars: { name: string; weight: number }[];
  ideaTitle: string;
  ideaHook: string | null;
  ideaContentPillar: string | null;
  ideaObjective: string | null;
  recentContentTitles: string[];
  researchTopics: { topic: string; rationale: string }[];
  activeExperiments: { name: string; hypothesis: string | null }[];
  /** Populated only when regenerating after a rejected version. */
  regenerationFeedback: string[];
}

export function buildContentCreatorPrompt(
  format: ContentFormat,
  context: ContentCreatorPromptContext,
): { systemPrompt: string; prompt: string } {
  const systemPrompt = [buildContentCreatorSystemPrompt(), FORMAT_INSTRUCTIONS[format]()].join("\n\n");
  const prompt = JSON.stringify(context, null, 2);
  return { systemPrompt, prompt };
}
