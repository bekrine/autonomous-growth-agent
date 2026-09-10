import type { Logger } from "@agent/shared";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

export interface HuggingFaceProviderOptions {
  /** A Hugging Face access token with "Inference Providers" permission (https://huggingface.co/settings/tokens). */
  apiKey: string;
  model?: string;
  maxRetries?: number;
  logger?: Logger;
}

const HF_ROUTER_BASE_URL = "https://router.huggingface.co/v1";

/**
 * Text generation via Hugging Face's Inference Providers router, which
 * exposes an OpenAI-chat-completions-compatible API — same request/response
 * shape as OpenAIProvider, just a different base URL and default model.
 * Free-tier friendly: no billing setup required to start.
 */
export class HuggingFaceProvider extends OpenAICompatibleProvider {
  constructor(options: HuggingFaceProviderOptions) {
    super({
      name: "huggingface",
      apiKey: options.apiKey,
      baseURL: HF_ROUTER_BASE_URL,
      model: options.model ?? "Qwen/Qwen3-4B-Instruct-2507",
      maxRetries: options.maxRetries,
      logger: options.logger,
    });
  }
}
