import OpenAI from "openai";
import type { GenerateTextInput, GenerateTextResult, LLMProvider } from "../provider.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? "gpt-4o-mini";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: input.maxTokens ?? 1024,
      temperature: input.temperature ?? 0.7,
      messages: [
        ...(input.systemPrompt
          ? [{ role: "system" as const, content: input.systemPrompt }]
          : []),
        { role: "user" as const, content: input.prompt },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    return {
      text,
      model: response.model,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  }
}
