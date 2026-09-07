import type { LLMProvider } from "./provider.js";
import { MockLLMProvider } from "./providers/mock-provider.js";
import { OpenAIProvider } from "./providers/openai-provider.js";

/**
 * Resolves the configured LLM provider. Falls back to the mock provider
 * when no API key is present so the system remains runnable out of the box.
 */
export function createLLMProvider(options: { openaiApiKey?: string }): LLMProvider {
  if (options.openaiApiKey) {
    return new OpenAIProvider({ apiKey: options.openaiApiKey });
  }
  return new MockLLMProvider();
}
