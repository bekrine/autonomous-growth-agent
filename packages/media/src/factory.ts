import type { ImageGenerator } from "./image-generator.js";
import type { VideoGenerator } from "./video-generator.js";
import { MockImageGenerator } from "./providers/mock-image-generator.js";
import { HuggingFaceImageGenerator } from "./providers/huggingface-image-generator.js";
import { MockVideoGenerator } from "./video-generator.js";
import { LocalObjectStorage, type ObjectStorage } from "./storage.js";

export interface CreateImageGeneratorOptions {
  huggingFaceApiKey?: string;
  huggingFaceModel?: string;
  huggingFaceProvider?: string;
  /**
   * Real image generation is opt-in rather than implied by having an HF
   * token, because (unlike HF text generation) it is not free — HF's own
   * `hf-inference` provider no longer serves text-to-image, so images
   * route to a paid third-party provider. Without this flag the pipeline
   * uses MockImageGenerator: fully functional, zero cost, and clearly
   * labeled as simulated.
   */
  imageGenerationEnabled?: boolean;
}

/** Falls back to the mock generator unless real image generation is explicitly enabled AND a key is present. */
export function createImageGenerator(options: CreateImageGeneratorOptions): ImageGenerator {
  if (options.imageGenerationEnabled && options.huggingFaceApiKey) {
    return new HuggingFaceImageGenerator({
      apiKey: options.huggingFaceApiKey,
      model: options.huggingFaceModel,
      provider: options.huggingFaceProvider,
    });
  }
  return new MockImageGenerator();
}

/** Real video generation isn't implemented this phase — always mock (see video-generator.ts). */
export function createVideoGenerator(): VideoGenerator {
  return new MockVideoGenerator();
}

export interface CreateObjectStorageOptions {
  localDir: string;
  publicBaseUrl: string;
}

export function createObjectStorage(options: CreateObjectStorageOptions): ObjectStorage {
  return new LocalObjectStorage(options.localDir, options.publicBaseUrl);
}
