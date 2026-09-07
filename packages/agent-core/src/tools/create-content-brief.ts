import type { LLMProvider } from "@agent/llm";
import type { Tool } from "../tool.js";

export interface CreateContentBriefInput {
  niche: string;
  ideaTitle: string;
}

export interface CreateContentBriefOutput {
  brief: string;
}

/** Uses the LLM abstraction directly — never a specific SDK — to draft a short content brief. */
export class CreateContentBriefTool implements Tool<CreateContentBriefInput, CreateContentBriefOutput> {
  readonly name = "createContentBrief";
  readonly description = "Draft a short content brief for a content idea.";

  constructor(private readonly llm: LLMProvider) {}

  async execute(input: CreateContentBriefInput) {
    const result = await this.llm.generateText({
      systemPrompt: "You write concise, one-paragraph content briefs for social media posts.",
      prompt: `Niche: ${input.niche}\nContent idea: ${input.ideaTitle}\nWrite a brief.`,
      maxTokens: 200,
    });
    return { success: true, data: { brief: result.text } };
  }
}
