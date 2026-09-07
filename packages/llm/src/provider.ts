/**
 * Provider-agnostic LLM abstraction. Agents and services depend only on
 * this interface, never on a specific SDK — swapping OpenAI for Anthropic,
 * Gemini, or a local model later means adding a new provider file, not
 * touching call sites.
 */
export interface GenerateTextInput {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateTextResult {
  text: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface LLMProvider {
  readonly name: string;
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
}
