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

`InstagramAdapter` and `FacebookAdapter` (`packages/social-platforms/src/adapters/`) are
stubs: they return deterministic mock data (`ig_<uuid>` post ids, empty comment lists,
zeroed analytics) instead of calling a real API. This lets every layer above them —
tools, agents, the policy layer, workers — be built and tested against a stable contract
before OAuth credentials and real API integration exist.

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

## Adding a real integration

Implement `SocialPlatform` for the platform (e.g. call the Instagram Graph API inside
`InstagramAdapter`), register it in `SocialPlatformRegistry`, and nothing else in the
system needs to change — no agent, tool signature, or database column depends on how a
platform is implemented.

## Adding a new platform

1. Add the name to `SOCIAL_PLATFORMS` in `packages/shared/src/domain-types.ts`.
2. Implement `SocialPlatform` in a new file under
   `packages/social-platforms/src/adapters/`.
3. Register it in `SocialPlatformRegistry`.
