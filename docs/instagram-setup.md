# Instagram setup

How to connect a real Instagram account and publish to it. Everything here is opt-in:
with no Meta credentials configured the app boots, the dashboard works, and every
Instagram endpoint returns a clean `503 INSTAGRAM_NOT_CONFIGURED`.

## 1. Account requirements

Instagram's Content Publishing API does **not** work with personal accounts. You need:

- An Instagram **Professional** account (Business or Creator) — switch in the Instagram
  app under Settings → Account type and tools.
- A **Facebook Page** linked to that Instagram account. Publishing is authorised through
  the Page, not the Instagram login: the API call is made with a *Page* access token.
- A Meta developer account (<https://developers.facebook.com>).

If the connected account turns out to be `personal`, `InstagramAuthService` rejects the
connection at the end of the OAuth flow rather than storing a credential that can never
publish.

## 2. Create the Meta app

1. <https://developers.facebook.com/apps> → **Create App** → use case **Other** → type
   **Business**.
2. Add the **Instagram Graph API** and **Facebook Login** products.
3. Under Facebook Login → Settings, add the redirect URI exactly as your
   `META_REDIRECT_URI` (below). Meta matches it character for character.
4. App Settings → Basic gives you the **App ID** and **App Secret**.

### Permissions

`INSTAGRAM_SCOPES` (`packages/social-platforms/src/instagram-auth.ts`) requests:

| Scope | Why |
|---|---|
| `instagram_basic` | Read the connected IG account's id/username |
| `instagram_content_publish` | Create media containers and publish them |
| `pages_show_list` | Find the Page linked to the IG account |
| `pages_read_engagement` | Obtain the Page access token used for publishing |

While the app is in **Development** mode these work for anyone with a role on the app
(admin/developer/tester) with no App Review. Publishing to an account *not* on the app
requires App Review and Business Verification. For a single self-operated account,
Development mode is enough — add your own account under App Roles.

## 3. Environment variables

```bash
META_APP_ID=...
META_APP_SECRET=...
META_REDIRECT_URI=http://localhost:4000/api/social/instagram/callback
META_API_VERSION=v21.0          # never hard-coded in source; override to upgrade
META_GRAPH_HOST=https://graph.facebook.com

# Generated once, then kept stable — rotating it makes stored tokens unreadable.
TOKEN_ENCRYPTION_KEY=<64 hex chars>

INSTAGRAM_PUBLISHING_ENABLED=false   # false → adapter refuses real Graph calls
AUTO_PUBLISH_ENABLED=false           # false → only human-initiated publishes allowed

MAX_POSTS_PER_DAY=5
MAX_POSTS_PER_HOUR=2
MIN_MINUTES_BETWEEN_POSTS=10
MAX_PUBLISH_ATTEMPTS=3
```

Generate the encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`TOKEN_ENCRYPTION_KEY` is a real secret: it decrypts every stored Instagram token. If it
is lost or changed, existing connections fail with `AUTHENTICATION_FAILED` (deliberately
classified as *permanent*, not retryable — see "Errors" below) and must be reconnected.

### Local callback

Meta accepts `http://localhost` redirect URIs for development, so the default above works
with no tunnel. A tunnel (ngrok, Cloudflare Tunnel) is only needed for **media URLs** —
see section 6.

## 4. The OAuth flow

```
Dashboard "Connect Instagram"
   → GET /api/social/instagram/connect?accountId=<uuid>
        creates a random 32-byte `state`, stored in `oauth_states`
        with the accountId and a 10-minute TTL
        returns { authorizationUrl } — the dashboard performs the redirect
   → user is sent to Meta's authorization dialog
   → user approves
   → GET /api/social/instagram/callback?code=...&state=...
        state consumed single-use (deleted on read; expired rows rejected)
        accountId is read FROM THE STORED STATE, never from the query string
   → exchange code            → short-lived user token
   → exchange for long-lived  → ~60-day user token
   → GET /me/accounts         → Page + its `instagram_business_account`
   → reject if account type is `personal`
   → Page access token encrypted (AES-256-GCM) and upserted into `social_connections`
   → 302 back to the dashboard
```

Two things the browser never sees: the authorization `code` and the access token. The
token exists in plaintext only in memory during the exchange; at rest it is
`v1:<iv>:<authTag>:<ciphertext>`. `GET /api/social/connections` returns username, status,
scopes and expiry — never the credential.

`UNIQUE(platform, platformAccountId)` means reconnecting the same Instagram account
updates the existing row instead of accumulating duplicates.

## 5. Publishing lifecycle

```
content_posts.status = ready_for_publishing   (Phase 3 reviewer approved it)
   ↓  POST /api/content/:id/publish   (or /schedule)
PublishingService.enqueue()
   ├─ validate media (format, count, publicly-fetchable URL)
   ├─ PolicyEngine.evaluate("publish_content")     ← kill switch authoritative
   ├─ publishing_jobs row via createIfAbsent()     ← UNIQUE idempotencyKey
   └─ outbox_events row — same transaction
   ↓  OutboxPublisher → BullMQ `publishing` queue
publishing-worker → PublishingService.execute(jobId)
   ├─ claimForPublishing()   ← conditional UPDATE; two workers cannot both claim
   ├─ re-evaluate policy     ← state may have changed since enqueue
   ├─ decrypt token
   └─ InstagramAdapter.publish()
        create container → poll status_code until FINISHED → media_publish
   ↓
publishing_jobs.status = published, externalPostId recorded
content_posts.status   = published
```

Idempotency is enforced by the **database**, not by application bookkeeping: the
`idempotencyKey` UNIQUE constraint makes a duplicate enqueue a no-op, and the conditional
`UPDATE ... WHERE status IN ('queued','scheduled','retry_scheduled')` claim makes a
redelivered BullMQ job a no-op. This is what stops a retry storm from publishing the same
post repeatedly.

Scheduling uses a persisted `scheduledFor` timestamp checked at execution time — not
`setTimeout`, which would lose every scheduled post on restart.

### Policies

`packages/policies/src/policies/publishing-policies.ts`. Denials short-circuit at the
first failure and surface as a structured `409` with a human-readable reason.

| Policy | Denies when |
|---|---|
| `PublishableContentPolicy` | content isn't ready/approved |
| `SocialConnectionPolicy` | connection missing, expired, revoked, or personal |
| `MediaReadyPolicy` | media missing or not a usable URL |
| `PublishingRateLimitPolicy` | per-day / per-hour / spacing limits exceeded |
| `AutoPublishPolicy` | `initiatedBy: "agent"` while `AUTO_PUBLISH_ENABLED=false` |
| `PublishingJobStatePolicy` | job cancelled, already published, or not yet due |

The global kill switch remains authoritative and cannot be bypassed by any publishing
path.

## 6. Media URL requirements

**Meta fetches your media from its own servers.** It must be a public HTTPS URL:
`localhost`, `127.0.0.1`, `*.local` and RFC1918 addresses are rejected before any API
call (`isPubliclyFetchableUrl()`), because Meta would fail on them anyway with a confusing
error.

| | Requirement |
|---|---|
| Image | **JPEG only** (`image/jpeg`) — PNG and WebP are rejected by Meta |
| Reel | MP4 (H.264/AAC) or MOV |
| Carousel | 2–10 items |

Note the mock image generator emits **SVG**, which Instagram will not accept. Real
publishing needs a real JPEG hosted somewhere public (S3/R2/Cloudinary, or a tunnel to
local storage).

## 7. Errors

`classifyMetaError()` maps Graph API responses onto `PUBLISHING_ERROR_CODES`, which
decides whether a job retries:

| Meta signal | Code | Retryable |
|---|---|---|
| code 190 | `AUTHENTICATION_FAILED` | no |
| code 10, 200–299 | `PERMISSION_DENIED` | no |
| code 4/17/32/613, HTTP 429 | `RATE_LIMITED` | yes |
| subcode 2207052 | `MEDIA_NOT_ACCESSIBLE` | no |
| other 2207xxx | `MEDIA_INVALID` | no |
| HTTP 5xx | `PLATFORM_ERROR` | yes |
| container never finishes | `CONTAINER_FAILED` | yes |
| unreadable stored token | `AUTHENTICATION_FAILED` | no |

Users see `publicMessageFor()` text, not raw Meta payloads — Graph internals stay in
server logs. Retries are bounded by `MAX_PUBLISH_ATTEMPTS`; exhausting them moves the job
to `failed`, never to an unbounded loop.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `503 INSTAGRAM_NOT_CONFIGURED` | `META_APP_ID`/`META_APP_SECRET`/`TOKEN_ENCRYPTION_KEY` unset |
| `Invalid OAuth redirect URI` | `META_REDIRECT_URI` ≠ the value registered in the Meta app |
| No IG account found after approving | Instagram account isn't Professional, or isn't linked to the Page |
| `MEDIA_NOT_ACCESSIBLE` | media URL isn't publicly reachable from the internet |
| `MEDIA_INVALID` on an image | not a JPEG |
| `AUTHENTICATION_FAILED` on a previously working connection | token expired (~60 days) or `TOKEN_ENCRYPTION_KEY` changed — reconnect |
| Publish denied, reason mentions autonomy | `AUTO_PUBLISH_ENABLED=false` and the request was agent-initiated |

## 8. Manual smoke test

Automated tests never call Meta. This procedure is the only real-publish path, and it is
deliberately manual.

1. Set `META_APP_ID`, `META_APP_SECRET`, `TOKEN_ENCRYPTION_KEY`, and
   `INSTAGRAM_PUBLISHING_ENABLED=true`. Leave `AUTO_PUBLISH_ENABLED=false`.
2. Start the stack (`docker compose up -d`, or the local dev processes).
3. Dashboard → **Social Accounts** → **Connect Instagram** → approve. The panel should
   show your `@username`, status `connected`, and the granted scopes.
4. Dashboard → **Content** → plan ideas → generate content, until a post reaches
   `READY_FOR_PUBLISHING`.
5. Replace the generated asset URL with a **public JPEG URL** (the mock generator's SVG
   will not publish).
6. Click **Publish Now**. Expect `202` and a job on the **Publishing** page moving
   `queued → publishing → published`.
7. Verify the post appears on the Instagram account, and that `publishing_jobs` holds the
   returned `externalPostId`.
8. Click **Publish Now** again on the same content — it must be rejected, not
   double-posted.
9. Set `INSTAGRAM_PUBLISHING_ENABLED=false` again when finished.

Never enable real publishing in CI.

## 9. Disconnecting

`DELETE /api/social/connections/:id` marks the connection `revoked` and clears the stored
ciphertext. Revoke Meta's side too, at
<https://www.facebook.com/settings?tab=business_tools>. Existing `publishing_jobs` rows
are kept for audit; new publishes are denied by `SocialConnectionPolicy`.
