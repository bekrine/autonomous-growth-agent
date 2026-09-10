import type { ContentGenerationRepository } from "@agent/database";
import { NotFoundError } from "@agent/shared";
import type { PublicMediaResolver, PublishMediaItem } from "@agent/social-platforms";

/**
 * Turns stored content assets into URLs Meta's servers can fetch.
 *
 * Today assets are written to local disk and served by the API at
 * `/media`, so the "public" URL is only genuinely public if
 * PUBLIC_MEDIA_BASE_URL points at something reachable from the internet
 * (a tunnel in development, a CDN in production). This class is the single
 * place that mapping lives, so swapping in signed S3/R2 URLs later means
 * implementing PublicMediaResolver — nothing else changes.
 *
 * Internal filesystem paths and storage credentials never leave here.
 */
export class StoredAssetMediaResolver implements PublicMediaResolver {
  constructor(private readonly contentGenerationRepository: ContentGenerationRepository) {}

  async getPublicUrl(assetId: string): Promise<string> {
    const asset = await this.findAsset(assetId);
    if (!asset.url) {
      throw new NotFoundError("Public URL for asset", assetId);
    }
    return asset.url;
  }

  /** Every completed asset for a generation, as platform-agnostic media items. */
  async resolveForGeneration(contentGenerationId: string): Promise<PublishMediaItem[]> {
    const assets = await this.contentGenerationRepository.listAssetsByGenerationId(contentGenerationId);

    return assets
      .filter((asset) => asset.status === "completed" && asset.url)
      .map((asset) => ({
        kind: asset.assetType === "video" ? ("video" as const) : ("image" as const),
        url: asset.url!,
        // Fall back to a sane default rather than guessing from the extension —
        // validation will reject anything Instagram can't accept anyway.
        mimeType: asset.mimeType ?? (asset.assetType === "video" ? "video/mp4" : "image/jpeg"),
      }));
  }

  private async findAsset(assetId: string) {
    const asset = await this.contentGenerationRepository.findAssetById(assetId);
    if (!asset) throw new NotFoundError("ContentAsset", assetId);
    return asset;
  }
}
