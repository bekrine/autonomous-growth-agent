# Social platforms

## The interface

`packages/social-platforms/src/types.ts` defines `SocialPlatform`:

```ts
interface SocialPlatform {
  publishPost(input: PublishPostInput): Promise<PublishResult>;
  getPost(postId: string): Promise<SocialPost>;
  getAnalytics(postId: string): Promise<PostAnalytics>;
  getComments(postId: string): Promise<Comment[]>;
  replyToComment(input: ReplyInput): Promise<ReplyResult>;
}
```

Every method uses generic, platform-agnostic shapes (`caption`, `mediaUrls: string[]`,
etc.) — no Instagram- or Facebook-specific fields leak into this interface or into the
`content_posts` table. Platform-specific request/response mapping is entirely internal to
each adapter.

## Current adapters

`InstagramAdapter` (`packages/social-platforms/src/adapters/instagram/`) is **real** as of
Phase 4 for publishing. Its `publish()` implements Meta's Content Publishing flow —
create media container → poll `status_code` until `FINISHED` → `media_publish` — over
`MetaGraphClient`, with the API version and host injected from config rather than
hard-coded. Carousels create one child container per item, wait for each, then publish a
`CAROUSEL` parent.

Its remaining `SocialPlatform` methods (`publishPost`, `getPost`, `getAnalytics`,
`getComments`, `replyToComment`) still throw as explicitly-marked stubs — they land in
Phase 5 (analytics) and Phase 6 (engagement). `FacebookAdapter` remains a mock throughout.

Real Graph calls only happen when `INSTAGRAM_PUBLISHING_ENABLED=true`; a `MockPublisher`
stands in otherwise, which is what the whole test suite runs against. See
`docs/instagram-setup.md`.

### Error mapping

`classifyMetaError()` (`graph-client.ts`) translates Graph responses into
`PUBLISHING_ERROR_CODES`, which is what decides retryable vs permanent. `publicMessageFor()`
produces the user-facing text, so raw Meta payloads never reach the dashboard — they stay
in server logs.

### Media validation

Media reaches the adapter as a plain public URL. `StoredAssetMediaResolver` maps
`content_assets` rows to `PublishMediaItem`s, so the adapter never learns whether the bytes
live in Cloudflare R2, on local disk, or anywhere else — see [`storage.md`](storage.md).

`packages/social-platforms/src/media-validation.ts` rejects bad media *before* any network
call: Instagram images must be JPEG, carousels must hold 2–10 items, and
`isPubliclyFetchableUrl()` refuses `localhost`, loopback, `.local` and RFC1918 hosts —
Meta fetches media from its own servers, so those can never work. `redactUrl()` strips
query strings before logging, since signed media URLs carry credentials.

`SocialPlatformRegistry` is the lookup agents/tools use instead of importing a concrete
adapter class:

```ts
const adapter = platforms.get("instagram"); // SocialPlatform
```

## How agents reach a platform

Agents never call an adapter directly. The path is always:

```
Agent → context.tools.call("publishPost", accountId, input) → PolicyEngine → PublishPostTool → SocialPlatformRegistry.get(platform) → adapter.publishPost()
```

`PublishPostTool`, `GetPostAnalyticsTool`, and `GetCommentsTool` in
`packages/agent-core/src/tools/` are the only code that touches
`SocialPlatformRegistry`.

## Publishing goes through PublishingService, not the tool router

Phase 4 publishing does **not** use the `publishPost` tool path above. An agent asking to
publish, and an operator clicking Publish Now, both land in
`PublishingService` (`packages/agent-core/src/publishing/`), which owns the
policy checks, the idempotent `publishing_jobs` row, token decryption, and retry
classification. The worker only calls `execute(jobId)`.

The distinction matters: `publishPost` is a fire-and-forget tool call, whereas a real
publish needs a durable, auditable, exactly-once job record. See
`docs/instagram-setup.md` for the full lifecycle.

## Adding a real integration

Implement `SocialPlatform` for the platform, register it in `SocialPlatformRegistry`, and
nothing else in the system needs to change — no agent, tool signature, or database column
depends on how a platform is implemented. `InstagramAdapter` is the worked example.

## Adding a new platform

1. Add the name to `SOCIAL_PLATFORMS` in `packages/shared/src/domain-types.ts`.
2. Implement `SocialPlatform` in a new file under
   `packages/social-platforms/src/adapters/`.
3. Register it in `SocialPlatformRegistry`.
