# Architecture

## Layered flow

```
Frontend (Next.js)
      ↓ HTTP
API (Express: routes → services)                    BullMQ Worker (agent-run job)
      ↓                                                       ↓
      └──────────────→ AgentRunService ←─────────────────────┘
                            ↓
                    AgentOrchestrator (packages/agent-core)
                            ↓
              AgentContextLoader ← repositories ← PostgreSQL
                            ↓
        ┌───────────────────┼────────────────────┐
        ↓                   ↓                    ↓
  ResearchAgent       StrategyAgent       ContentPlannerAgent
        ↓                   ↓                    ↓
  LLMProvider.generateStructured() (packages/llm) — Zod-validated, retried, provider-agnostic
        └───────────────────┼────────────────────┘
                            ↓
        Persistence (transactional, idempotent) → PostgreSQL
                            ↓
                Policies (kill switch, content approval,
                rate limit, platform availability, human approval)
                            ↓
        Tools (searchWeb, getAccount, publishPost, ...) → External platforms / LLM / media
```

Every arrow above is a hard boundary enforced by TypeScript interfaces, not just a
convention: routes depend on `AgentRunService` (framework-agnostic, in `packages/agent-core`,
used identically by the API and the worker), agents depend on `AgentContext` and a
`ToolRouter` (never a repository or an adapter directly), and tools are the only code
allowed to reach into `packages/database` or `packages/social-platforms`. Agents call
`context.llm.generateStructured()` for every decision — never a specific SDK, and never
free-form text parsed with regex.

## Content generation pipeline (Phase 3)

A second pipeline runs against a single planned content idea rather than the whole account:

```
Content Planner  (Phase 2, produces content_ideas)
      ↓
Content Idea
      ↓
Content Creator  → structured GeneratedContent (reel | carousel | image | text)
      ↓
Media Generator  → generateImage tool → Policy → ImageGenerator → MediaStorageService
                                                                   → JPEG conversion → Cloudflare R2 → public URL
      ↓
Reviewer         → quality / brand / safety / accuracy / duplication / platform-readiness
      ↓
   approved?
   ├── yes → READY_FOR_PUBLISHING     (handed to the Phase 4 publishing pipeline)
   └── no  → regenerate with the reviewer's recommendedChanges
             (bounded by MAX_CONTENT_GENERATION_ATTEMPTS, default 3) → REVIEW_FAILED
```

Entry points are `AgentOrchestrator.generateContent()` via `AgentRunService`, reachable
synchronously (`POST /api/content/:ideaId/generate`) or asynchronously (the `content`
queue's `generate-content` job) — the same single implementation either way.

Media generation goes through the tool router like any other side-effecting capability, so
the kill switch and `DailyGenerationLimitPolicy` (cost control) apply to it; nothing
bypasses the policy layer to call an image provider directly.

### Provider abstractions

| Concern | Interface | Implementations |
|---|---|---|
| Text generation | `LLMProvider` (`packages/llm`) | `HuggingFaceProvider`, `OpenAIProvider` (both via `OpenAICompatibleProvider`), `MockLLMProvider` |
| Image generation | `ImageGenerator` (`packages/media`) | `HuggingFaceImageGenerator`, `MockImageGenerator` |
| Video generation | `VideoGenerator` (`packages/media`) | `MockVideoGenerator` only — real video is out of scope this phase |
| Asset storage | `ObjectStorage` (`packages/media`) | `CloudflareR2Storage` (real, S3-compatible), `LocalObjectStorage` (fallback, served by the API at `/media`), `InMemoryObjectStorage` (tests) |
| Image conversion | `convertImageToJpeg` (`packages/media`) | `sharp` — re-encodes SVG/PNG/WebP to the JPEG Instagram requires |

Everything is selected by a factory from env config, and every one falls back to a mock so
the whole pipeline runs with no API keys at all. Object storage follows the same rule: R2
is used only when fully configured, otherwise local disk — see
[`docs/storage.md`](storage.md).

Generated media is what connects Phase 3 to Phase 4: Meta fetches media from its own
servers, so an asset is only publishable once it has a genuinely public HTTPS URL. R2
provides that URL and `sharp` guarantees the bytes are real JPEG, which is why the
Instagram adapter never needs to know where media is stored — it receives a URL from the
service layer and nothing more.

## Publishing pipeline (Phase 4)

Where content generation ends, publishing begins. The crucial difference is that this
pipeline has an **irreversible external side effect**, so its design is built around
"exactly once" rather than "eventually correct".

```
READY_FOR_PUBLISHING
      ↓  operator clicks Publish/Schedule  (or an agent asks, if autonomy is on)
PublishingService.enqueue()
      ├── media validation      (JPEG-only, 2–10 carousel items, publicly fetchable URL)
      ├── PolicyEngine          (kill switch → content → connection → media → rate limit → autonomy)
      └── publishing_jobs row + outbox_events row   — one transaction
      ↓  OutboxPublisher → `publishing` queue
publishing-worker → PublishingService.execute(jobId)
      ├── claim (conditional UPDATE — the concurrency guard)
      ├── re-evaluate policy    (state may have changed since enqueue)
      ├── decrypt Page token    (AES-256-GCM, in memory only)
      └── InstagramAdapter.publish()
             container → poll status_code → media_publish
      ↓
published  |  retry_scheduled (bounded)  |  failed
```

Three rules shape this:

1. **The business logic lives in `PublishingService`, not the worker.** The processor is
   ~20 lines of plumbing. The API and the queue therefore cannot drift, exactly as with
   `AgentRunService` in Phase 2.
2. **Idempotency is enforced by the database**, not by application bookkeeping — a UNIQUE
   `idempotency_key` and a conditional claim. See `docs/database.md`.
3. **Autonomy is off by default.** `AUTO_PUBLISH_ENABLED=false` makes `AutoPublishPolicy`
   deny any `initiatedBy: "agent"` request, so the system cannot publish without a human
   until that is deliberately switched on. The kill switch remains authoritative above it.

Credentials never leave the server: `social_connections` stores AES-256-GCM ciphertext,
the OAuth `code` and the access token are never logged or returned to the browser, and the
dashboard only ever sees username/status/scopes. `docs/instagram-setup.md` covers the
setup and the manual smoke test.

## Analytics pipeline (Phase 5)

Publishing produces an irreversible effect; analytics measures what that effect achieved.

```
PublishingService (published)
      ↓  outbox: content.published            — same transaction as the publish
analytics-worker → AnalyticsService.schedulePostCollection()
      ↓  (repeatable sweep, bounded window ladder: ~1h, ~6h, ~24h, ~72h)
AnalyticsService.collectForPost()
      ├── InstagramAnalyticsProvider → Meta Graph API
      ├── normalize      (platform names → canonical; unavailable stays unavailable)
      ├── derive         (engagement/share/save rates — refuse to divide by zero)
      └── persist        (raw snapshot + normalized metrics, append-only)
      ↓
baseline (median) + performance score  → AnalyticsAgent → insights → dashboard
```

Four rules shape it:

1. **Raw is never replaced by derived.** Snapshots keep the sanitized provider payload
   alongside normalized metrics, so a normalization bug stays diagnosable.
2. **Unavailable is not zero.** A metric the platform withheld is recorded as unavailable;
   treating it as 0 would corrupt every average, baseline and rate built on it.
3. **No LLM in the measurement path.** Collection and scoring are deterministic arithmetic.
   The AnalyticsAgent runs only when interpretation is requested.
4. **Measurement does not change strategy.** The agent writes insights, never
   `strategy_versions` — Phase 5 is "measured", not "learned".

See [`docs/analytics.md`](analytics.md).

## Experiment engine (Phase 6)

Analytics tells you what happened; experiments tell you whether a deliberate change made a
difference.

```
Analytics insight
      ↓  ExperimentAgent proposes (LLM)
ExperimentValidationService decides (code)   ← confounders, samples, concurrency
      ↓
Experiment ──┬── control arm ──┐
             └── variant arm ──┤  interleaved across publishing slots
                               ↓
        Content Creator (Phase 3) → PublishingService (Phase 4) → Instagram
                               ↓
                    AnalyticsService (Phase 5)
                               ↓
   ExperimentEvaluationService (deterministic) → result → recommendation
```

Four rules shape it:

1. **The LLM proposes; code decides.** Allowed variables, metric existence, sample rules,
   duration and concurrency are enforced in ordinary code. The confounder check rejects
   designs whose arms differ in more than the variable under test — otherwise a result
   cannot be attributed to anything.
2. **Arms are interleaved, not batched.** Publishing all controls Monday and all variants
   Friday would make the day the variable.
3. **No statistics from the LLM.** Medians, lift and confidence are computed. Confidence
   never reaches "high" and has an absolute sample floor, because no significance test is
   performed — results are *directional*.
4. **No strategy mutation.** Phase 6 ends at a recommendation; Phase 7 owns acting on it.

See [`docs/experiments.md`](experiments.md).

## Why a modular monolith

The API, the three workers, and the agent-core/database/policies/llm/social-platforms
packages all run as separate Node processes but share one Postgres database and one
Redis instance. This keeps deployment and local development simple (`docker compose up`
starts everything) while still letting workers scale independently of the API. Splitting
into real microservices before there's a concrete scaling reason to would add
coordination cost (service discovery, distributed transactions, versioned contracts)
without a matching benefit — see rule 13/14 in the root README.

## Request/response vs. async paths

Three execution paths reach the same agent run, and none of them contain business logic
of their own — they all call `AgentRunService`, which calls `AgentOrchestrator`:

1. **Synchronous API path**: `POST /api/agent/runs` calls `AgentRunService.startRun()`
   directly and waits for it to finish before responding with the full result (research,
   strategy, content ideas). This is what makes "trigger a run and see it complete" work
   without any queue infrastructure in the loop.
2. **Queued API path**: `POST /api/agent/runs/queue` enqueues a job on the `agent-run`
   BullMQ queue via `AgentQueueProducer` and returns immediately with a job id.
   `agent-worker` consumes that queue and calls the *same* `AgentRunService` — see
   `docs/queues.md`.
3. **Async/outbox path**: business-record writes (e.g. a new `content_posts` row) can also
   write an `outbox_events` row in the same transaction. `OutboxPublisher` (running inside
   `agent-worker`) polls pending outbox rows, publishes each to the matching BullMQ queue,
   and marks it published. Workers then process the per-stage queues (`research`,
   `strategy`, `content`, `publishing`, `analytics`, `experiments`) with (currently
   placeholder) handlers — this is the path real publishing/analytics collection will run
   through once implemented.

All three write through the same repositories, so PostgreSQL stays the single source of
truth regardless of which path produced the write, and every write is idempotent per
`(agentRunId)` — see `docs/database.md`.

## Where future features plug in

| Feature | Where it goes |
|---|---|
| Real trend/competitor research | Implement `ResearchProvider` (`packages/agent-core/src/research/`) and pass it to `buildAgentSystem({ researchProvider })` — `ResearchAgent` doesn't change |
| Real strategy versioning UI | `apps/api/src/services/strategy.service.ts` + `apps/web/src/app/strategy` (data already persisted by the orchestrator) |
| Real video generation | Implement `VideoGenerator` (`packages/media`) + a `generateVideo` tool alongside `generateImage`; the reel format already produces a scene-by-scene script to render from |
| Real object storage (S3/R2) | Implement `ObjectStorage` (`packages/media/src/storage.ts`) using the reserved `STORAGE_*` env vars — no call site changes |
| **Publishing (Phase 4)** | `PublishPostTool` + `publishing-worker` already exist; take a `content_posts` row in `ready_for_publishing`, render its `content_generations.payload` for the target platform, and call `SocialPlatform.publishPost`. Nothing in the generation pipeline needs to change |
| Real Instagram/Facebook calls | `packages/social-platforms/src/adapters/*` (implement `SocialPlatform`, no other file needs to change) |
| Comment/community management | `CommunityAgent` + `getComments`/`replyToComment` on `SocialPlatform` |
| A/B experiment analysis | `ExperimentAgent` + `experiments`/`experiment_variants` tables |
| Additional LLM providers (Anthropic, Gemini, local) | `packages/llm/src/providers/*.ts`, implement `LLMProvider` |
| Additional social platforms (TikTok, YouTube, LinkedIn) | New adapter in `packages/social-platforms/src/adapters`, register in `SocialPlatformRegistry` |

None of these require touching `AgentOrchestrator`, the Express route layer, or the
database schema's core shape — that's the point of the abstraction boundaries above.
