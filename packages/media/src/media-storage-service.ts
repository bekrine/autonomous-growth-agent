import type { Logger } from "@agent/shared";
import { convertImageToJpeg, INSTAGRAM_IMAGE_MIME_TYPE, isConvertibleImage } from "./image-conversion.js";
import { buildObjectKey, type MediaKind } from "./object-key.js";
import { StorageError } from "./errors.js";
import type { ObjectStorage } from "./storage.js";

/**
 * The seam between "we produced some bytes" and "there is a durable object
 * with a public URL". It owns three concerns that would otherwise leak into
 * the agent pipeline:
 *
 *   1. object-key construction (never from a supplied filename),
 *   2. making an image genuinely publishable (SVG/PNG -> JPEG),
 *   3. normalized failures + structured logging without leaking credentials.
 *
 * It depends on the ObjectStorage interface, so it works identically against
 * R2, local disk, or the in-memory test double.
 */

export interface StoreImageInput {
  accountId: string;
  contentId: string;
  assetId: string;
  data: Buffer;
  mimeType: string;
  kind?: Extract<MediaKind, "images" | "thumbnails">;
  /** Convert to JPEG so the object is directly publishable. Default true. */
  ensurePublishable?: boolean;
  prefix?: string;
}

export interface StoreVideoInput {
  accountId: string;
  contentId: string;
  assetId: string;
  data: Buffer;
  mimeType?: string;
  prefix?: string;
}

export interface StoredMedia {
  objectKey: string;
  publicUrl: string;
  contentType: string;
  size: number;
  storageProvider: string;
  width?: number;
  height?: number;
  /** True when the bytes were re-encoded on the way in (e.g. SVG -> JPEG). */
  converted: boolean;
  /** The generator's original MIME type, retained so the audit trail is honest. */
  originalMimeType: string;
}

export class MediaStorageService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly logger?: Logger,
  ) {}

  get providerName(): string {
    return this.storage.name;
  }

  async storeImage(input: StoreImageInput): Promise<StoredMedia> {
    const started = Date.now();
    const ensurePublishable = input.ensurePublishable ?? true;

    let data = input.data;
    let mimeType = input.mimeType;
    let width: number | undefined;
    let height: number | undefined;
    let converted = false;

    if (ensurePublishable && mimeType.toLowerCase() !== INSTAGRAM_IMAGE_MIME_TYPE) {
      if (!isConvertibleImage(mimeType)) {
        throw new StorageError("STORAGE_INVALID_MEDIA", `Cannot publish media of type ${mimeType}.`);
      }
      const result = await convertImageToJpeg(data, mimeType);
      data = result.data;
      mimeType = result.mimeType;
      width = result.width;
      height = result.height;
      converted = result.converted;
    }

    const objectKey = buildObjectKey({
      accountId: input.accountId,
      contentId: input.contentId,
      assetId: input.assetId,
      kind: input.kind ?? "images",
      mimeType,
      prefix: input.prefix,
    });

    const stored = await this.storage.put({
      key: objectKey,
      data,
      contentType: mimeType,
      metadata: this.buildMetadata(input.accountId, input.contentId, input.assetId),
    });

    this.logUpload({
      assetId: input.assetId,
      contentId: input.contentId,
      objectKey,
      size: stored.size,
      mimeType,
      converted,
      startedAt: started,
    });

    return {
      objectKey: stored.key,
      publicUrl: stored.url,
      contentType: stored.contentType,
      size: stored.size,
      storageProvider: this.storage.name,
      width,
      height,
      converted,
      originalMimeType: input.mimeType,
    };
  }

  async storeVideo(input: StoreVideoInput): Promise<StoredMedia> {
    const started = Date.now();
    const mimeType = input.mimeType ?? "video/mp4";

    const objectKey = buildObjectKey({
      accountId: input.accountId,
      contentId: input.contentId,
      assetId: input.assetId,
      kind: "videos",
      mimeType,
      prefix: input.prefix,
    });

    const stored = await this.storage.put({
      key: objectKey,
      data: input.data,
      contentType: mimeType,
      metadata: this.buildMetadata(input.accountId, input.contentId, input.assetId),
    });

    this.logUpload({
      assetId: input.assetId,
      contentId: input.contentId,
      objectKey,
      size: stored.size,
      mimeType,
      converted: false,
      startedAt: started,
    });

    return {
      objectKey: stored.key,
      publicUrl: stored.url,
      contentType: stored.contentType,
      size: stored.size,
      storageProvider: this.storage.name,
      converted: false,
      originalMimeType: mimeType,
    };
  }

  /** Exposed through the abstraction so deleted content can eventually drop its objects. */
  async deleteAsset(objectKey: string): Promise<void> {
    await this.storage.delete(objectKey);
    this.logger?.info({ objectKey, storageProvider: this.storage.name }, "media.asset_deleted");
  }

  async exists(objectKey: string): Promise<boolean> {
    return this.storage.exists(objectKey);
  }

  async getPublicUrl(objectKey: string): Promise<string> {
    return this.storage.getPublicUrl(objectKey);
  }

  /**
   * Confirms an object is actually there and has a URL. The optional HEAD
   * check proves the URL is reachable by an outside fetcher (Meta), but it
   * costs a round trip, so it stays opt-in rather than running on every
   * upload.
   */
  async verifyPublicUrl(
    objectKey: string,
    options: { checkReachable?: boolean; timeoutMs?: number } = {},
  ): Promise<{ objectKey: string; publicUrl: string; exists: boolean; reachable?: boolean; contentType?: string }> {
    const [exists, publicUrl] = await Promise.all([this.storage.exists(objectKey), this.storage.getPublicUrl(objectKey)]);

    if (!options.checkReachable) return { objectKey, publicUrl, exists };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const response = await fetch(publicUrl, { method: "HEAD", signal: controller.signal });
      return {
        objectKey,
        publicUrl,
        exists,
        reachable: response.ok,
        contentType: response.headers.get("content-type") ?? undefined,
      };
    } catch {
      return { objectKey, publicUrl, exists, reachable: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ids only — never tokens, keys, or user content. Metadata travels with the object. */
  private buildMetadata(accountId: string, contentId: string, assetId: string): Record<string, string> {
    return { "account-id": accountId, "content-id": contentId, "asset-id": assetId };
  }

  private logUpload(fields: {
    assetId: string;
    contentId: string;
    objectKey: string;
    size: number;
    mimeType: string;
    converted: boolean;
    startedAt: number;
  }) {
    this.logger?.info(
      {
        assetId: fields.assetId,
        contentId: fields.contentId,
        objectKey: fields.objectKey,
        storageProvider: this.storage.name,
        size: fields.size,
        mimeType: fields.mimeType,
        converted: fields.converted,
        durationMs: Date.now() - fields.startedAt,
        status: "uploaded",
      },
      "media.uploaded",
    );
  }
}
