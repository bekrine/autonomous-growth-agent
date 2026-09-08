import type { GenerateTextInput, GenerateTextResult, LLMProvider, StructuredGenerationInput } from "../provider.js";
import { fakeFromSchema } from "../mock-schema-faker.js";

/**
 * Deterministic provider used in tests and local development when no API
 * key is configured, so the rest of the system — including structured
 * generation — can be exercised end to end without a live LLM dependency.
 * `generateStructured` fakes a schema-valid value rather than calling any
 * model; the values carry no semantic meaning.
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

  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    return fakeFromSchema(input.schema);
  }
}
