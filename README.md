# Autonomous Growth Agent

A production-oriented foundation for an autonomous AI agent that operates social-media
accounts and continuously improves their growth. Phase 1 built the scaffolding (monorepo,
database, queues, API, policy/kill-switch layer, dashboard shell), Phase 2 made the
planning agents reason with a real LLM, Phase 3 turns their plans into reviewed content,
and Phase 4 publishes it to a real Instagram account:

```
Account → ResearchAgent → StrategyAgent → ContentPlannerAgent → content ideas
                                                                     ↓
   ContentCreatorAgent → media generation → ReviewerAgent → READY_FOR_PUBLISHING
                              ↑                    ↓                    ↓
                              └──── regenerate ◄───┘         PublishingService → Instagram
                                 (bounded, max 3 attempts)
```

Publishing is **human-initiated by default** (`AUTO_PUBLISH_ENABLED=false`) — the agent
can prepare posts autonomously, but a person approves each one until you decide otherwise.

The end-state feedback loop this foundation is built to support:

```
OBSERVE → THINK → PLAN → CREATE → REVIEW → ACT → MEASURE → LEARN → UPDATE STRATEGY → REPEAT
```

See [`docs/architecture.md`](docs/architecture.md) for the full system design,
[`docs/agents.md`](docs/agents.md) for how the agents reason and what they persist, and
[`docs/local-development.md`](docs/local-development.md) to get running.
[`docs/instagram-setup.md`](docs/instagram-setup.md) covers connecting a real Instagram
account, [`docs/storage.md`](docs/storage.md) how generated media reaches Cloudflare R2, and
[`docs/analytics.md`](docs/analytics.md) how published content is measured.

## Stack

- **Frontend**: Next.js (App Router), TypeScript, Tailwind CSS, React Query, Recharts
- **Backend**: Node.js, TypeScript, Express, PostgreSQL, Redis, BullMQ
- **Database layer**: [Drizzle ORM](https://orm.drizzle.team/) — chosen over Prisma because
  it's SQL-first (no codegen step blocking builds), migrations are plain, auditable `.sql`
  files, and its query builder stays close enough to SQL to keep the repository layer thin
  and easy to reason about — important for a system where every write must be traceable.
- **LLM output**: every agent decision is a Zod-validated structured JSON response
  (`LLMProvider.generateStructured`), retried on invalid output — never free-form text
  parsed with regex.
- **Providers**: text via Hugging Face (free tier) or OpenAI; images via Hugging Face;
  asset storage via Cloudflare R2 (S3-compatible) with a local-disk fallback — all behind
  interfaces, all defaulting to mocks so the system runs with zero API keys.
- **Infra**: Docker, Docker Compose, npm workspaces monorepo

## Repository layout

```
apps/
  web/              Next.js dashboard
  api/               Express API (routes → services)
workers/
  agent-worker/      Real "agent-run" BullMQ processor (same AgentRunService as the API) +
                      research/strategy/content/experiments placeholders + outbox publisher
  publishing-worker/ BullMQ worker for the publishing queue
  analytics-worker/  BullMQ worker for the analytics queue
packages/
  shared/            env config, logging, errors, queue names/job types, redis factory
  database/          Drizzle schema, client, repositories, migration runner, dev seed script
  agent-core/        AgentContext/AgentContextLoader, Agent/Tool/Orchestrator, AgentRunService,
                      the 3 functional agents, prompts, ResearchProvider
  llm/               Provider-agnostic LLM abstraction: generateText + generateStructured
                      (Zod-validated, retried), OpenAI + mock implementations
  social-platforms/  SocialPlatform interface + real Instagram adapter, Facebook stub
  policies/          PolicyEngine, kill switch, concrete policies
  media/             Image/video generation, JPEG conversion, and ObjectStorage (R2)
migrations/          Generated SQL migrations (Drizzle Kit)
docker/              Dockerfiles for api/web/workers
docs/                Architecture and subsystem documentation
```

## Quick start

```bash
cp .env.example .env
docker compose up
```

Then:

```bash
curl http://localhost:4000/api/health

# seed a runnable dev account (niche + goal), then trigger a real agent run
npm run db:seed --workspace=@agent/database
curl -X POST http://localhost:4000/api/agent/runs \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"<id from db:seed output or GET /api/accounts>"}'
```

Or open the dashboard's **Agent Activity** page and click **Start Agent Run** — it drives
the same API. Without `OPENAI_API_KEY` set, agents run against a mock LLM provider that
fakes schema-valid output, so the full pipeline works out of the box; set the key to get
real reasoning.

See [`docs/local-development.md`](docs/local-development.md) for running without Docker,
applying migrations, and the full verification walkthrough.

## Architectural rules this codebase follows

1. No business logic in Express route handlers — routes call services (`AgentRunService`
   for agent runs), never the orchestrator directly.
2. No database queries inside agents — `AgentContextLoader` loads all state before a run
   starts; agents receive it as plain data, never a repository.
3. No social-platform SDK code inside agents — only `packages/social-platforms` adapters.
4. Agents can never bypass the policy layer — they only hold a `ToolRouter`, never a raw tool.
5. The agent system is not coupled to one LLM provider (`packages/llm`), and every agent
   decision is schema-validated (Zod) before it's trusted or persisted.
6. The content model (`content_posts`/`content_ideas`) is platform-agnostic — no
   Instagram-specific fields.
7. Redis/BullMQ are for async jobs only — PostgreSQL is the single source of truth.
8. Every autonomous decision and action is persisted as structured, queryable data — no
   hidden chain-of-thought, only concise reasoning summaries and scores.
9. Every multi-table write (a strategy version + its decision + action, etc.) is
   transactional and idempotent per `agent_run_id` — a retried run never duplicates rows.
10. The same `AgentRunService` is called by the synchronous API path, the queued API path,
    and the BullMQ worker — "run an agent run" has exactly one implementation.
11. Modular monolith first — no premature microservices.

## Status

**Phases 1–5 are complete.**

- **Phase 1** — foundation: monorepo, schema, queues, API, policy layer, dashboard shell.
- **Phase 2** — ResearchAgent, StrategyAgent and ContentPlannerAgent reason over real
  account context with `LLMProvider.generateStructured`; research topics, strategy versions
  and content ideas are transactionally persisted and idempotent under retry.
- **Phase 3** — ContentCreatorAgent and ReviewerAgent turn a content idea into a reviewed,
  versioned content package (format-specific: reel script / carousel slides / image copy /
  text body, plus caption, CTA, keywords, alt text and a generated cover image), looping
  through bounded regeneration until approved. Terminal state: `READY_FOR_PUBLISHING`.
- **Phase 4** — real Instagram publishing via the Meta Graph API: OAuth connection with
  AES-256-GCM encrypted tokens, a `PublishingService` that owns policy + idempotency +
  retry classification, a `publishing` queue driven by the outbox, and dashboard controls
  for publishing, scheduling, cancelling and tracking jobs. Autonomy ships **off**
  (`AUTO_PUBLISH_ENABLED=false`): only human-initiated publishes are allowed until you
  turn it on. See [`docs/instagram-setup.md`](docs/instagram-setup.md).
- **Phase 5** — analytics and growth intelligence: Instagram media/account insights behind
  a `PlatformAnalyticsProvider` abstraction, append-only raw snapshots plus normalized
  metrics, deterministic derived rates and a median-based baseline, a bounded collection
  ladder driven by the `analytics` queue and the outbox, and an `AnalyticsAgent` that
  explains the numbers. It **measures** — it does not change strategy; that is Phase 7.
  See [`docs/analytics.md`](docs/analytics.md).
- **Media storage** — generated assets live in **Cloudflare R2** behind the existing
  `ObjectStorage` abstraction, with SVG→JPEG conversion so every stored image is genuinely
  publishable. Only `CloudflareR2Storage` knows R2 exists; the Instagram adapter just
  receives a public URL. See [`docs/storage.md`](docs/storage.md).

Still typed skeletons: `ExperimentAgent`, `CommunityAgent`.
Still stubs by design: the `FacebookAdapter`, Instagram comments/DMs (Phase 6), real
research/trend sources, video generation.

### Known limitations

- Hugging Face's free tier no longer serves text-to-image, so real image generation
  (`IMAGE_GENERATION_ENABLED=true`) requires Inference Provider credits. Left off, the
  pipeline uses `MockImageGenerator` — fully functional and clearly labeled as simulated.
- Generated assets are written to local disk; `STORAGE_*` is reserved for a real
  object-storage provider.
- Rate/cost limiters are in-memory, so they're per-process — move the counters to Redis
  before running multiple API/worker instances. (Publishing rate limits are the exception:
  they count rows in `publishing_jobs`, so they hold across processes.)
- Instagram publishing requires media at a **public HTTPS URL** — Meta fetches it
  server-side — and images must be **JPEG**. Both are now handled: generated media is
  uploaded to **Cloudflare R2** and any SVG/PNG is re-encoded to JPEG with `sharp`
  ([`docs/storage.md`](docs/storage.md)). Without `R2_*` configured the system falls back
  to local disk, whose URLs Meta cannot reach.
- R2's public development URL (`pub-*.r2.dev`) is rate-limited and not intended for
  production traffic — attach a custom domain to the bucket before real load.
- Instagram **insights require the `instagram_manage_insights` permission**. It is in
  `INSTAGRAM_SCOPES`, but a connection authorized before Phase 5 must be reconnected —
  an older token does not carry it, and every `/insights` call returns
  `(#10) Application does not have permission` until it is re-granted.
- Long-lived Meta tokens expire in ~60 days and are not auto-refreshed yet; the dashboard
  surfaces the expiry and the connection must be re-authorized.
- The Meta app runs in Development mode, so it can only publish to accounts with a role on
  the app. Publishing on behalf of others needs App Review and Business Verification.
