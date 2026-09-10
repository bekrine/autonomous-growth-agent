/**
 * Provider-agnostic image generation. Kept separate from ContentCreatorAgent
 * for the same reason as LLMProvider — concrete implementations (Hugging
 * Face, OpenAI, a local model, ...) implement this interface without the
 * content-generation pipeline depending on any specific vendor. Returns raw
 * bytes; persisting them to storage and recording asset metadata is the
 * caller's job (packages/agent-core), not the generator's.
 */
export interface ImageGenerationInput {
  prompt: string;
  aspectRatio?: "1:1" | "4:5" | "9:16" | "16:9";
}

export interface ImageGenerationResult {
  imageData: Buffer;
  mimeType: string;
  provider: string;
  providerAssetId?: string;
  width?: number;
  height?: number;
}

export interface ImageGenerator {
  readonly name: string;
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}
