import type { Logger } from "@agent/shared";
import type { LLMProvider } from "./provider.js";
import { MockLLMProvider } from "./providers/mock-provider.js";
import { OpenAIProvider } from "./providers/openai-provider.js";
import { HuggingFaceProvider } from "./providers/huggingface-provider.js";

export interface CreateLLMProviderOptions {
  huggingFaceApiKey?: string;
  huggingFaceModel?: string;
  openaiApiKey?: string;
  model?: string;
  maxRetries?: number;
  logger?: Logger;
}

/**
 * Resolves the configured LLM provider. Hugging Face takes priority when
 * configured (free-tier friendly, no billing setup), then OpenAI, then the
 * mock provider — so the system remains runnable out of the box with no
 * keys at all.
 */
export function createLLMProvider(options: CreateLLMProviderOptions): LLMProvider {
  if (options.huggingFaceApiKey) {
    return new HuggingFaceProvider({
      apiKey: options.huggingFaceApiKey,
      model: options.huggingFaceModel,
      maxRetries: options.maxRetries,
      logger: options.logger,
    });
  }
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
