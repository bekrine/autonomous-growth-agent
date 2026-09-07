import type { GenerateTextInput, GenerateTextResult, LLMProvider } from "../provider.js";

/**
 * Deterministic provider used in tests and local development when no API
 * key is configured, so the rest of the system can be exercised end to end
 * without a live LLM dependency.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return {
      text: `[mock response for prompt of length ${input.prompt.length}]`,
      model: "mock-model",
      usage: { promptTokens: input.prompt.length, completionTokens: 0 },
    };
  }
}
