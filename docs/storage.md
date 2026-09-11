# Media storage

Generated images and videos are objects in **Cloudflare R2**, reached through an
S3-compatible API. Asset *metadata* lives in Postgres (`content_assets`); the *bytes*
never do.

## Why it exists

Instagram publishing forced the issue. Meta fetches media **from its own servers**, so a
`http://localhost:4000/media/...` URL can never work — and the mock generator emits SVG,
which Instagram rejects outright. R2 solves the first problem (a real public HTTPS URL);
`sharp` solves the second (genuine JPEG re-encoding).

## The abstraction

```ts
interface ObjectStorage {
  readonly name: string;
  put(input: PutObjectInput): Promise<PutObjectResult>;
  getPublicUrl(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}
```

| Implementation | Used when |
|---|---|
| `CloudflareR2Storage` | R2 is fully configured — the real path |
| `LocalObjectStorage` | fallback; writes to disk, served by the API at `/media` |
| `InMemoryObjectStorage` | tests — no disk, no network, bytes stay assertable |

`MediaStorageService` sits on top and owns the three things that would otherwise leak into
the agent pipeline: object-key construction, making an image publishable (JPEG), and
normalized failures plus structured logging.

**`packages/media/src/providers/cloudflare-r2-storage.ts` is the only file that knows R2
exists.** Adding another provider means writing a sibling class and changing one factory
branch — no agent, tool, or platform adapter changes.

```
ContentCreatorAgent
      ↓ (tool router → policy engine)
GenerateImageTool
      ↓
ImageGenerator  →  bytes (SVG from the mock, PNG/JPEG from a real provider)
      ↓
MediaStorageService  →  convert to JPEG → upload
      ↓
ObjectStorage (CloudflareR2Storage)
      ↓
public URL → content_assets row → PublishingService → InstagramAdapter
```

## Configuration

```env
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=autonomous-growth-media
R2_PUBLIC_BASE_URL=https://pub-<id>.r2.dev
R2_INTEGRATION_TEST=false
```

R2 is selected only when **all five** settings are present. A partially-configured bucket
falls back to local disk rather than producing URLs that Meta cannot fetch.

### Cloudflare setup

1. **R2 → Create bucket** → `autonomous-growth-media`.
2. **Manage R2 API Tokens → Create User API Token**. Scope it to *Object Read & Write* for
   this bucket only — not account-wide. The token page yields the Access Key ID and Secret
   Access Key, shown once.
3. `R2_ACCOUNT_ID` is your Cloudflare account id (also visible in the S3 endpoint,
   `https://<account-id>.r2.cloudstorage.com`).
4. **Bucket → Settings → Public Development URL → Enable.** This yields
   `https://pub-<hash>.r2.dev`, which is what makes objects anonymously readable — the
   requirement for Meta to fetch them. It grants public **read** only; writes still
   require the API token.

The endpoint is built as `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` with
`forcePathStyle: false`. Nothing is hard-coded.

> The public development URL is rate-limited and not meant for production traffic. Attach
> a custom domain to the bucket before real load.

### Docker

`api`, `agent-worker`, `publishing-worker` and `analytics-worker` declare `env_file: .env`,
so every `R2_*` value reaches them with no compose changes and **no secrets in
`docker-compose.yml`**.

The `web` service deliberately does **not** load `.env` — it receives only `API_URL`. That
is what keeps R2 credentials out of the frontend container and out of any browser bundle.
Keep it that way when adding variables: anything the dashboard needs must arrive through
the API, not the environment.

## Object keys

```
accounts/{accountId}/content/{contentId}/images/{assetId}.jpg
accounts/{accountId}/content/{contentId}/videos/{assetId}.mp4
accounts/{accountId}/content/{contentId}/thumbnails/{assetId}.jpg
```

Keys are built **only from ids we generated ourselves** — never from a filename produced by
a model or supplied by a user, which would invite traversal, collisions and unbounded key
lengths. `sanitizeKeySegment()` additionally strips path separators and collapses dot runs,
so a malformed id cannot escape its prefix.

The asset row's id names the object, so the database row and the stored object share one
identity. That makes the upload **idempotent**: retrying writes the same key, overwriting
rather than accumulating duplicates.

Integration-test objects live under `_test/` and are the only keys the test cleanup will
delete.

## Image conversion

Instagram accepts **JPEG only**. `convertImageToJpeg()` re-encodes SVG/PNG/WebP with
`sharp`, flattening transparency onto white (JPEG has no alpha, so without this it goes
black). An existing JPEG passes through untouched rather than being re-encoded.

The original and publishable types stay distinct: `content_assets.mime_type` records what
was stored, and the storage result carries `originalMimeType` plus a `converted` flag, so
nothing pretends an SVG was always a JPEG.

SVGs are rasterized at density 72, which maps their declared pixel dimensions 1:1. Raising
it inflates the raster (144 quadruples the pixel count and measured ~6.7× slower) for no
gain, since our generated SVGs already declare the target size.

## Database

`content_assets` stores metadata only:

| Column | Meaning |
|---|---|
| `storage_key` | object key in the bucket |
| `url` | public URL (what the dashboard and Meta fetch) |
| `mime_type` | type of the **stored** object, post-conversion |
| `provider` | which generator made the bytes (`mock`, `huggingface`) |
| `storage_provider` | which ObjectStorage holds them (`cloudflare-r2`, `local-disk`) |
| `size_bytes`, `width`, `height`, `duration_seconds` | measured from the stored object |
| `status` | `requested → generating → completed \| failed` |

`provider` and `storage_provider` answer different questions and change independently —
that is why they are separate columns (migration `0005`).

## Security

`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_ACCOUNT_ID` are server-side secrets.
They live only in `.env`, are never committed, never logged, never placed in an error
message, and never sent to the browser.

- The S3 client is constructed once inside `CloudflareR2Storage`; credentials do not leave it.
- `getPublicUrl()` is pure string construction — no credentials, no signing, no network call.
- Storage failures are normalized to `StorageError` codes. The raw SDK message (which can
  carry bucket names and signing details) is kept in `providerDetail` for server logs only.
- A missing-configuration error names the *fields* that are absent, never their values.
- The browser receives `publicUrl`, `mimeType`, `storageProvider`, `sizeBytes` and `status`
  — nothing else. `apps/api/src/__tests__/media-secrets.test.ts` asserts this with sentinel
  credentials that must never appear in any response body.
- Uploaded object metadata carries ids only (`account-id`, `content-id`, `asset-id`) — no
  secrets, no personal data. It travels with the object.

## Failure handling

`StorageError` normalizes every failure:

| Code | Retryable | Typical cause |
|---|---|---|
| `STORAGE_NOT_CONFIGURED` | no | missing env vars |
| `STORAGE_AUTHENTICATION_FAILED` | no | wrong/revoked API token |
| `STORAGE_BUCKET_NOT_FOUND` | no | bucket name wrong or deleted |
| `STORAGE_OBJECT_NOT_FOUND` | no | key does not exist |
| `STORAGE_INVALID_MEDIA` | no | empty buffer, or a type we cannot publish |
| `STORAGE_UNAVAILABLE` | yes | 5xx / network |
| `STORAGE_TIMEOUT` | yes | request timed out |

Retries are bounded (3 attempts) and only transient codes are retried, so a 403 fails
immediately instead of burning attempts. Because keys are deterministic, a retry cannot
create a duplicate object.

## Testing

```bash
npm test                      # unit tests; S3 client mocked, never touches Cloudflare
```

The real bucket is exercised only by an opt-in test:

```bash
set -a && source .env && set +a
R2_INTEGRATION_TEST=true npx vitest run packages/media/src/__tests__/r2-integration.test.ts
```

It uploads under `_test/`, fetches the public URL over HTTPS, asserts the content type and
length, then deletes the object. **Never enable it in CI.**

## Lifecycle

`MediaStorageService.deleteAsset(objectKey)` removes an object through the abstraction.
Nothing deletes automatically: an asset may still be referenced by published content, and
Instagram keeps its own copy after publishing but the URL may still be consulted. Deliberate
lifecycle policies are left to a later phase.
