import { AppError } from "@agent/shared";

export class ImageGenerationError extends AppError {
  constructor(provider: string, message: string) {
    super(`Image generation failed (${provider}): ${message}`, {
      statusCode: 502,
      code: "IMAGE_GENERATION_ERROR",
    });
  }
}

export const STORAGE_ERROR_CODES = [
  "STORAGE_NOT_CONFIGURED",
  "STORAGE_AUTHENTICATION_FAILED",
  "STORAGE_BUCKET_NOT_FOUND",
  "STORAGE_UNAVAILABLE",
  "STORAGE_TIMEOUT",
  "STORAGE_OBJECT_NOT_FOUND",
  "STORAGE_INVALID_MEDIA",
  "STORAGE_ERROR",
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

/** Transient conditions worth one more attempt; everything else fails fast. */
const RETRYABLE: ReadonlySet<StorageErrorCode> = new Set<StorageErrorCode>([
  "STORAGE_UNAVAILABLE",
  "STORAGE_TIMEOUT",
]);

/**
 * Normalized storage failure. The raw AWS SDK error is deliberately not
 * propagated: its messages can carry bucket names, endpoints and request
 * signing details that should not reach an API consumer. `providerDetail`
 * is for server-side logs only and is never serialized to a response.
 */
export class StorageError extends AppError {
  constructor(
    readonly storageCode: StorageErrorCode,
    message: string,
    readonly providerDetail?: string,
  ) {
    super(message, { statusCode: storageCode === "STORAGE_NOT_CONFIGURED" ? 500 : 502, code: storageCode });
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.storageCode);
  }
}

export class ImageConversionError extends AppError {
  constructor(message: string) {
    super(`Image conversion failed: ${message}`, { statusCode: 500, code: "IMAGE_CONVERSION_ERROR" });
  }
}
