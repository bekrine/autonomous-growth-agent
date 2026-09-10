import { generateId } from "@agent/shared";
import type { ImageGenerator, ObjectStorage } from "@agent/media";
import type { Tool } from "../tool.js";

export interface GenerateImageToolInput {
  prompt: string;
  aspectRatio?: "1:1" | "4:5" | "9:16" | "16:9";
}

export interface GenerateImageToolOutput {
  storageKey: string;
  url: string;
  mimeType: string;
  provider: string;
  providerAssetId?: string;
  width?: number;
  height?: number;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * The only place that calls a real ImageGenerator + writes to object
 * storage — routed through the policy layer (kill switch,
 * DailyGenerationLimitPolicy) exactly like publishPost, so media
 * generation can never bypass cost/safety controls.
 */
export class GenerateImageTool implements Tool<GenerateImageToolInput, GenerateImageToolOutput> {
  readonly name = "generateImage";
  readonly description = "Generate a real image asset for a piece of content and persist it to object storage.";

  constructor(
    private readonly imageGenerator: ImageGenerator,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(input: GenerateImageToolInput) {
    const result = await this.imageGenerator.generate({ prompt: input.prompt, aspectRatio: input.aspectRatio });
    const extension = EXTENSION_BY_MIME[result.mimeType] ?? "bin";
    const key = `content/${generateId()}.${extension}`;
    const stored = await this.storage.put({ key, data: result.imageData, contentType: result.mimeType });

    return {
      success: true,
      data: {
        storageKey: stored.key,
        url: stored.url,
        mimeType: result.mimeType,
        provider: result.provider,
        providerAssetId: result.providerAssetId,
        width: result.width,
        height: result.height,
      },
    };
  }
}
