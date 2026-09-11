import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Where generated files actually live. Rule: asset *metadata* goes to
 * Postgres (content_assets), the *bytes* never do. `key` is a
 * storage-relative path (e.g. "accounts/<id>/content/<id>/images/<id>.jpg");
 * `url` is what a client — or Meta's servers — fetch.
 */
export interface PutObjectInput {
  key: string;
  data: Buffer;
  contentType: string;
  /**
   * Optional object metadata (content id, asset id, account id). Useful for
   * tracing an object in the bucket back to the row that owns it. Never put
   * secrets or personal data here — it travels with the object.
   */
  metadata?: Record<string, string>;
  /** Cache-Control for the stored object. Generated media is immutable. */
  cacheControl?: string;
}

export interface PutObjectResult {
  key: string;
  url: string;
  contentType: string;
  size: number;
}

/**
 * Provider-independent object storage. Implementations: LocalObjectStorage
 * (development fallback), CloudflareR2Storage (real), InMemoryObjectStorage
 * (tests). Nothing above this interface knows which one is in use — that is
 * what lets the Instagram adapter stay unaware that R2 exists.
 */
export interface ObjectStorage {
  readonly name: string;
  put(input: PutObjectInput): Promise<PutObjectResult>;
  /** Deterministic public URL for a key. Must not require credentials to resolve. */
  getPublicUrl(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/**
 * Local-disk storage, used when R2 is not configured. `apps/api` serves this
 * directory statically at `/media`, so the URL is real and fetchable —
 * but only from wherever PUBLIC_MEDIA_BASE_URL points, which in development
 * is localhost and therefore NOT reachable by Meta. Real publishing needs R2.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly name = "local-disk";

  constructor(
    private readonly baseDir: string,
    private readonly publicBaseUrl: string,
  ) {}

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    const fullPath = join(this.baseDir, input.key);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, input.data);
    return {
      key: input.key,
      url: await this.getPublicUrl(input.key),
      contentType: input.contentType,
      size: input.data.byteLength,
    };
  }

  async getPublicUrl(key: string): Promise<string> {
    return `${this.publicBaseUrl}/${key}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(join(this.baseDir, key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(join(this.baseDir, key), { force: true });
  }
}

/**
 * In-memory storage for tests: no disk, no network, no credentials, and the
 * stored bytes stay inspectable so a test can assert what was uploaded.
 */
export class InMemoryObjectStorage implements ObjectStorage {
  readonly name = "in-memory";
  readonly objects = new Map<string, { data: Buffer; contentType: string; metadata?: Record<string, string> }>();

  constructor(private readonly publicBaseUrl = "https://test-storage.invalid") {}

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    this.objects.set(input.key, { data: input.data, contentType: input.contentType, metadata: input.metadata });
    return {
      key: input.key,
      url: await this.getPublicUrl(input.key),
      contentType: input.contentType,
      size: input.data.byteLength,
    };
  }

  async getPublicUrl(key: string): Promise<string> {
    return `${this.publicBaseUrl}/${key}`;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
