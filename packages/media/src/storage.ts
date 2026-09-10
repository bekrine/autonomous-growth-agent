import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Where generated files actually live. Rule: asset *metadata* goes to
 * Postgres (content_assets), the *bytes* never do. `key` is a
 * storage-relative path (e.g. "content/<uuid>.png"); `url` is what a
 * client fetches.
 */
export interface PutObjectInput {
  key: string;
  data: Buffer;
  contentType: string;
}

export interface PutObjectResult {
  key: string;
  url: string;
}

export interface ObjectStorage {
  readonly name: string;
  put(input: PutObjectInput): Promise<PutObjectResult>;
}

/**
 * Local-disk storage used until a real STORAGE_* (S3/R2/etc) provider is
 * configured — `STORAGE_ENDPOINT` etc. are reserved in .env.example for
 * that. `apps/api` serves this directory statically at `/media`, so a
 * `LocalObjectStorage` URL is real and fetchable, not a placeholder.
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
    return { key: input.key, url: `${this.publicBaseUrl}/${input.key}` };
  }
}
