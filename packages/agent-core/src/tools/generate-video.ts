import type { MediaStorageService, VideoGenerator } from "@agent/media";
import type { Tool } from "../tool.js";

export interface GenerateVideoToolInput {
  prompt: string;
  /** Seconds. Clamped to Instagram's Reels minimum — see MIN_REEL_SECONDS. */
  durationSeconds?: number;
  accountId: string;
  contentId: string;
  assetId: string;
}

export interface GenerateVideoToolOutput {
  storageKey: string;
  url: string;
  mimeType: string;
  provider: string;
  storageProvider: string;
  sizeBytes: number;
  durationSeconds?: number;
  providerAssetId?: string;
}

/**
 * Instagram rejects Reels shorter than 3 seconds. Asking a model for 2s and
 * then failing at the Meta container is a slow, confusing way to discover
 * that, so the floor is enforced here instead.
 */
export const MIN_REEL_SECONDS = 4;

/**
 * The only place that calls a real VideoGenerator and persists the result —
 * routed through the policy layer exactly like generateImage, so the kill
 * switch and DailyGenerationLimitPolicy apply to video too (the policy already
 * counts "generateVideo" toward the same daily budget).
 *
 * Video generation is slow: a few seconds of footage takes 1–3 minutes to
 * render. Callers that cannot block should use the `content` queue rather than
 * the synchronous generate endpoint.
 */
export class GenerateVideoTool implements Tool<GenerateVideoToolInput, GenerateVideoToolOutput> {
  readonly name = "generateVideo";
  readonly description = "Generate a real video asset for a piece of content and persist it to object storage.";

  constructor(
    private readonly videoGenerator: VideoGenerator,
    private readonly mediaStorage: MediaStorageService,
  ) {}

  async execute(input: GenerateVideoToolInput) {
    const durationSeconds = Math.max(MIN_REEL_SECONDS, input.durationSeconds ?? MIN_REEL_SECONDS);

    const result = await this.videoGenerator.generate({ prompt: input.prompt, durationSeconds });

    // The mock generator returns a structurally valid but non-playable MP4, and
    // a real provider may legitimately report "mocked". Either way, without
    // bytes there is nothing to store.
    if (!result.videoData) {
      return {
        success: false,
        error: `Video generator "${result.provider}" returned no video data (status: ${result.status}).`,
      };
    }

    const stored = await this.mediaStorage.storeVideo({
      accountId: input.accountId,
      contentId: input.contentId,
      assetId: input.assetId,
      data: result.videoData,
      mimeType: result.mimeType,
    });

    return {
      success: true,
      data: {
        storageKey: stored.objectKey,
        url: stored.publicUrl,
        mimeType: stored.contentType,
        provider: result.provider,
        storageProvider: stored.storageProvider,
        sizeBytes: stored.size,
        durationSeconds: result.durationSeconds,
        providerAssetId: result.assetId,
      },
    };
  }
}
