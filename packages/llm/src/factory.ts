import type { Logger } from "@agent/shared";
import type { LLMProvider } from "./provider.js";
import { MockLLMProvider } from "./providers/mock-provider.js";
import { OpenAIProvider } from "./providers/openai-provider.js";

export interface CreateLLMProviderOptions {
  openaiApiKey?: string;
  model?: string;
  maxRetries?: number;
  logger?: Logger;
}

/**
 * Resolves the configured LLM provider. Falls back to the mock provider
 * when no API key is present so the system remains runnable out of the box.
 */
export function createLLMProvider(options: CreateLLMProviderOptions): LLMProvider {
  if (options.openaiApiKey) {
    return new OpenAIProvider({
      apiKey: options.openaiApiKey,
      model: options.model,
      maxRetries: options.maxRetries,
      logger: options.logger,
    });
  }
  return new MockLLMProvider();
}
