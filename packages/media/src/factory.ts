import type { ImageGenerator } from "./image-generator.js";
import type { VideoGenerator } from "./video-generator.js";
import { MockImageGenerator } from "./providers/mock-image-generator.js";
import { HuggingFaceImageGenerator } from "./providers/huggingface-image-generator.js";
import { AgnesImageGenerator } from "./providers/agnes-image-generator.js";
import { AgnesVideoGenerator } from "./providers/agnes-video-generator.js";
import { MockVideoGenerator } from "./video-generator.js";
import { LocalObjectStorage, type ObjectStorage } from "./storage.js";
import { CloudflareR2Storage } from "./providers/cloudflare-r2-storage.js";

export interface CreateImageGeneratorOptions {
  huggingFaceApiKey?: string;
  huggingFaceModel?: string;
  huggingFaceProvider?: string;
  /** Agnes AI — free tier, 30 requests/minute for images. Preferred when present. */
  agnesApiKey?: string;
  agnesImageModel?: string;
  agnesBaseUrl?: string;
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

/**
 * Falls back to the mock generator unless real image generation is explicitly
 * enabled AND a key is present.
 *
 * Agnes is preferred over Hugging Face when both are configured: its image
 * tier is genuinely free, whereas HF's own provider no longer serves
 * text-to-image and routes to a paid third party.
 */
export function createImageGenerator(options: CreateImageGeneratorOptions): ImageGenerator {
  if (options.imageGenerationEnabled && options.agnesApiKey) {
    return new AgnesImageGenerator({
      apiKey: options.agnesApiKey,
      model: options.agnesImageModel,
      baseUrl: options.agnesBaseUrl,
    });
  }
  if (options.imageGenerationEnabled && options.huggingFaceApiKey) {
    return new HuggingFaceImageGenerator({
      apiKey: options.huggingFaceApiKey,
      model: options.huggingFaceModel,
      provider: options.huggingFaceProvider,
    });
  }
  return new MockImageGenerator();
}

export interface CreateVideoGeneratorOptions {
  agnesApiKey?: string;
  agnesVideoModel?: string;
  agnesBaseUrl?: string;
  /**
   * Opt-in separately from image generation: the free video tier allows only
   * 2 requests/minute, and a single clip takes minutes to render.
   */
  videoGenerationEnabled?: boolean;
}

/** Mock unless video generation is explicitly enabled AND a key is present. */
export function createVideoGenerator(options: CreateVideoGeneratorOptions = {}): VideoGenerator {
  if (options.videoGenerationEnabled && options.agnesApiKey) {
    return new AgnesVideoGenerator({
      apiKey: options.agnesApiKey,
      model: options.agnesVideoModel,
      baseUrl: options.agnesBaseUrl,
    });
  }
  return new MockVideoGenerator();
}

export interface CreateObjectStorageOptions {
  localDir: string;
  publicBaseUrl: string;
  r2?: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicBaseUrl: string;
  };
}

/** True only when every R2 setting is present — a partial config would silently produce unreachable URLs. */
export function isR2Configured(r2: CreateObjectStorageOptions["r2"]): boolean {
  return Boolean(r2?.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucket && r2.publicBaseUrl);
}

/**
 * Selects R2 when it is fully configured, otherwise falls back to local disk
 * so the stack still runs with no cloud credentials at all. Callers depend on
 * the returned ObjectStorage interface and never on which branch was taken.
 */
export function createObjectStorage(options: CreateObjectStorageOptions): ObjectStorage {
  if (isR2Configured(options.r2)) {
    const r2 = options.r2!;
    return new CloudflareR2Storage({
      accountId: r2.accountId,
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
      bucket: r2.bucket,
      publicBaseUrl: r2.publicBaseUrl,
    });
  }
  return new LocalObjectStorage(options.localDir, options.publicBaseUrl);
}
