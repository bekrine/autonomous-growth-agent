import type { Logger } from "@agent/shared";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  maxRetries?: number;
  logger?: Logger;
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(options: OpenAIProviderOptions) {
    super({
      name: "openai",
      apiKey: options.apiKey,
      model: options.model ?? "gpt-4o-mini",
      maxRetries: options.maxRetries,
      logger: options.logger,
    });
  }
}
