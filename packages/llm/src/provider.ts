import type { ZodType } from "zod";

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

export interface StructuredGenerationInput<T> {
  /** Static role/instructions — kept separate from dynamic context per the prompt layer convention. */
  systemPrompt: string;
  /** Dynamic context (account state, research signals, etc.), already rendered to text. */
  prompt: string;
  /** Runtime-validated against the parsed JSON response before it's returned. */
  schema: ZodType<T>;
  /** Short name used in logs/errors and in the "respond with JSON matching X" instruction. */
  schemaName: string;
  maxTokens?: number;
  temperature?: number;
  /** Overrides the provider's configured default retry count for this call. */
  maxRetries?: number;
  /** Metadata surfaced to the observability hook — never logged prompt/output content. */
  runId?: string;
  agentName?: string;
}

export interface LLMProvider {
  readonly name: string;
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  /**
   * Generates a JSON response and validates it against `schema` before
   * returning, retrying on invalid/malformed output up to the configured
   * limit. Callers never parse free-form text themselves.
   */
  generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T>;
}
