import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { StorageError } from "../errors.js";
import type { ObjectStorage, PutObjectInput, PutObjectResult } from "../storage.js";

export interface CloudflareR2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Cloudflare public development URL (https://pub-<id>.r2.dev) or a custom domain. */
  publicBaseUrl: string;
  /** Bounded retry for transient failures. Uploads are idempotent (fixed key), so a retry cannot duplicate an object. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Cloudflare R2 via its S3-compatible API. This is the only file in the
 * codebase that knows R2 exists — everything above it depends on
 * ObjectStorage, so swapping in another provider means adding a sibling
 * class and changing one factory branch.
 *
 * Credentials live only in this object's S3Client and are never logged,
 * returned, or included in a thrown error.
 */
export class CloudflareR2Storage implements ObjectStorage {
  readonly name = "cloudflare-r2";

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly maxAttempts: number;

  constructor(config: CloudflareR2Config) {
    const missing = (["accountId", "accessKeyId", "secretAccessKey", "bucket", "publicBaseUrl"] as const).filter(
      (k) => !config[k],
    );
    if (missing.length > 0) {
      // Names only — never the values.
      throw new StorageError(
        "STORAGE_NOT_CONFIGURED",
        `Cloudflare R2 is not fully configured. Missing: ${missing.join(", ")}.`,
      );
    }

    this.bucket = config.bucket;
    // Trailing slash here would produce "//key" in every public URL.
    this.publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      // R2 uses virtual-hosted-style addressing, like S3.
      forcePathStyle: false,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Retries are handled by this class so they apply uniformly across
      // every operation and stay visibly bounded.
      maxAttempts: 1,
    });
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    if (input.data.byteLength === 0) {
      throw new StorageError("STORAGE_INVALID_MEDIA", "Refusing to upload an empty object.");
    }

    await this.run("upload", () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.data,
          ContentType: input.contentType,
          ContentLength: input.data.byteLength,
          CacheControl: input.cacheControl ?? IMMUTABLE_CACHE_CONTROL,
          Metadata: input.metadata,
        }),
      ),
    );

    return {
      key: input.key,
      url: await this.getPublicUrl(input.key),
      contentType: input.contentType,
      size: input.data.byteLength,
    };
  }

  /**
   * Pure string construction — deliberately no network call and no
   * credentials, so the URL stays cheap to produce and safe to hand to the
   * browser or to Meta.
   */
  async getPublicUrl(key: string): Promise<string> {
    return `${this.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.run("head", () => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })));
      return true;
    } catch (error) {
      if (error instanceof StorageError && error.storageCode === "STORAGE_OBJECT_NOT_FOUND") return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.run("delete", () => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })));
  }

  /** Bounded retry: only transient classifications are retried, so a 403 fails immediately. */
  private async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    let lastError: StorageError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = classifyStorageError(operation, error);
        if (!lastError.retryable || attempt === this.maxAttempts) throw lastError;
      }
    }

    throw lastError ?? new StorageError("STORAGE_ERROR", `Storage ${operation} failed.`);
  }
}

/**
 * Maps S3/R2 SDK failures onto normalized codes. The provider's own message
 * is kept only in `providerDetail` for logs — the user-facing message says
 * what happened without naming buckets, endpoints or keys.
 */
export function classifyStorageError(operation: string, error: unknown): StorageError {
  const err = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name ?? err?.Code ?? "";
  const detail = `${operation}: ${name || "unknown"}${status ? ` (http ${status})` : ""}`;

  if (name === "NotFound" || name === "NoSuchKey" || status === 404) {
    // A missing *bucket* is a configuration problem; a missing key is normal.
    if (name === "NoSuchBucket") {
      return new StorageError("STORAGE_BUCKET_NOT_FOUND", "The media storage bucket does not exist.", detail);
    }
    return new StorageError("STORAGE_OBJECT_NOT_FOUND", "The requested media object does not exist.", detail);
  }
  if (name === "NoSuchBucket") {
    return new StorageError("STORAGE_BUCKET_NOT_FOUND", "The media storage bucket does not exist.", detail);
  }
  if (status === 401 || status === 403 || name === "InvalidAccessKeyId" || name === "SignatureDoesNotMatch") {
    return new StorageError(
      "STORAGE_AUTHENTICATION_FAILED",
      "Media storage rejected the credentials. Check the R2 API token.",
      detail,
    );
  }
  if (name === "TimeoutError" || name === "RequestTimeout" || /timeout/i.test(err?.message ?? "")) {
    return new StorageError("STORAGE_TIMEOUT", "Media storage timed out.", detail);
  }
  if ((status !== undefined && status >= 500) || name === "NetworkingError" || name === "ECONNREFUSED") {
    return new StorageError("STORAGE_UNAVAILABLE", "Media storage is temporarily unavailable.", detail);
  }

  return new StorageError("STORAGE_ERROR", "Media storage failed to complete the operation.", detail);
}
