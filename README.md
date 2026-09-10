# Autonomous Growth Agent

A production-oriented foundation for an autonomous AI agent that operates social-media
accounts and continuously improves their growth. This repository is **not** the full
autonomous system yet — Phase 1 built the scaffolding (monorepo, database, queues, API,
policy/kill-switch layer, dashboard shell), Phase 2 made the planning agents reason with a
real LLM, and Phase 3 turns their plans into reviewed, ready-to-publish content:

```
Account → ResearchAgent → StrategyAgent → ContentPlannerAgent → content ideas
                                                                     ↓
   ContentCreatorAgent → media generation → ReviewerAgent → READY_FOR_PUBLISHING
                              ↑                    ↓
                              └──── regenerate ◄───┘  (bounded, max 3 attempts)
```

Nothing publishes yet — `READY_FOR_PUBLISHING` is deliberately the terminal state.
Publishing to Instagram/Facebook is Phase 4.

The end-state feedback loop this foundation is built to support:

```
OBSERVE → THINK → PLAN → CREATE → REVIEW → ACT → MEASURE → LEARN → UPDATE STRATEGY → REPEAT
```

See [`docs/architecture.md`](docs/architecture.md) for the full system design,
[`docs/agents.md`](docs/agents.md) for how the agents reason and what they persist, and
[`docs/local-development.md`](docs/local-development.md) to get running.

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
  assets via local-disk or (later) S3/R2 — all behind interfaces, all defaulting to mocks
  so the system runs with zero API keys.
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
  social-platforms/  SocialPlatform interface + Instagram/Facebook stub adapters
  policies/          PolicyEngine, kill switch, concrete policies
  media/             Provider-agnostic media-generation abstraction (stub)
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

**Phases 1–3 are complete.**

- **Phase 1** — foundation: monorepo, schema, queues, API, policy layer, dashboard shell.
- **Phase 2** — ResearchAgent, StrategyAgent and ContentPlannerAgent reason over real
  account context with `LLMProvider.generateStructured`; research topics, strategy versions
  and content ideas are transactionally persisted and idempotent under retry.
- **Phase 3** — ContentCreatorAgent and ReviewerAgent turn a content idea into a reviewed,
  versioned content package (format-specific: reel script / carousel slides / image copy /
  text body, plus caption, CTA, keywords, alt text and a generated cover image), looping
  through bounded regeneration until approved. Terminal state: `READY_FOR_PUBLISHING`.

Still typed skeletons: `AnalyticsAgent`, `ExperimentAgent`, `CommunityAgent`.
Still stubs by design: social platform adapters, real research/trend sources, video
generation. **Publishing is intentionally not implemented** — see
[`docs/architecture.md`](docs/architecture.md) for exactly where Phase 4 plugs in.

### Known limitations

- Hugging Face's free tier no longer serves text-to-image, so real image generation
  (`IMAGE_GENERATION_ENABLED=true`) requires Inference Provider credits. Left off, the
  pipeline uses `MockImageGenerator` — fully functional and clearly labeled as simulated.
- Generated assets are written to local disk; `STORAGE_*` is reserved for a real
  object-storage provider.
- Rate/cost limiters are in-memory, so they're per-process — move the counters to Redis
  before running multiple API/worker instances.
