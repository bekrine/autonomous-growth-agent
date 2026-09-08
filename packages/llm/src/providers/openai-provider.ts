import OpenAI from "openai";
import type { Logger } from "@agent/shared";
import type {
  GenerateTextInput,
  GenerateTextResult,
  LLMProvider,
  StructuredGenerationInput,
} from "../provider.js";
import { generateStructuredWithRetry } from "../structured-retry.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  /** Default retry count for generateStructured; overridable per call. */
  maxRetries?: number;
  /** Structured request metadata (never prompt/output content) for debugging. */
  logger?: Logger;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly defaultMaxRetries: number;
  private readonly logger?: Logger;

  constructor(options: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? "gpt-4o-mini";
    this.defaultMaxRetries = options.maxRetries ?? 3;
    this.logger = options.logger;
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

  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    return generateStructuredWithRetry({
      schema: input.schema,
      schemaName: input.schemaName,
      maxRetries: input.maxRetries ?? this.defaultMaxRetries,
      generate: async (feedback) => {
        const startedAt = Date.now();
        let success = false;
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        try {
          const response = await this.client.chat.completions.create({
            model: this.model,
            max_tokens: input.maxTokens ?? 1024,
            temperature: input.temperature ?? 0.2,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: input.prompt },
              ...(feedback ? [{ role: "user" as const, content: feedback }] : []),
            ],
          });
          promptTokens = response.usage?.prompt_tokens;
          completionTokens = response.usage?.completion_tokens;
          success = true;
          return response.choices[0]?.message?.content ?? "";
        } finally {
          this.logger?.info(
            {
              runId: input.runId,
              agentName: input.agentName,
              provider: this.name,
              model: this.model,
              schemaName: input.schemaName,
              durationMs: Date.now() - startedAt,
              success,
              promptTokens,
              completionTokens,
              retried: Boolean(feedback),
            },
            "llm.structured_request",
          );
        }
      },
    });
  }
}
