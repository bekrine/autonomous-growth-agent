# Autonomous Growth Agent

A production-oriented foundation for an autonomous AI agent that operates social-media
accounts and continuously improves their growth. This repository is **not** the full
autonomous system — it is the clean, extensible scaffolding it will be built on top of:
monorepo layout, database schema, queues, API, a minimal agent orchestrator with mock
agents, a policy/kill-switch layer, and a dashboard shell.

The end-state feedback loop this foundation is built to support:

```
OBSERVE → THINK → PLAN → CREATE → REVIEW → ACT → MEASURE → LEARN → UPDATE STRATEGY → REPEAT
```

See [`docs/architecture.md`](docs/architecture.md) for the full system design and
[`docs/local-development.md`](docs/local-development.md) to get running.

## Stack

- **Frontend**: Next.js (App Router), TypeScript, Tailwind CSS, React Query, Recharts
- **Backend**: Node.js, TypeScript, Express, PostgreSQL, Redis, BullMQ
- **Database layer**: [Drizzle ORM](https://orm.drizzle.team/) — chosen over Prisma because
  it's SQL-first (no codegen step blocking builds), migrations are plain, auditable `.sql`
  files, and its query builder stays close enough to SQL to keep the repository layer thin
  and easy to reason about — important for a system where every write must be traceable.
- **Infra**: Docker, Docker Compose, npm workspaces monorepo

## Repository layout

```
apps/
  web/              Next.js dashboard
  api/               Express API (routes → services → repositories)
workers/
  agent-worker/      BullMQ workers for research/strategy/content/experiments + outbox publisher
  publishing-worker/ BullMQ worker for the publishing queue
  analytics-worker/  BullMQ worker for the analytics queue
packages/
  shared/            env config, logging, errors, queue names, redis factory
  database/          Drizzle schema, client, repositories, migration runner
  agent-core/        Agent/Tool/Orchestrator abstractions + concrete agents & tools
  llm/               Provider-agnostic LLM abstraction (OpenAI + mock implementations)
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
```

See [`docs/local-development.md`](docs/local-development.md) for running without Docker,
applying migrations, and triggering a full agent run.

## Architectural rules this codebase follows

1. No business logic in Express route handlers — routes call services, services call repositories.
2. No database queries inside agents — only tools query the database.
3. No social-platform SDK code inside agents — only `packages/social-platforms` adapters.
4. Agents can never bypass the policy layer — they only hold a `ToolRouter`, never a raw tool.
5. The agent system is not coupled to one LLM provider (`packages/llm`).
6. The content model (`content_posts`) is platform-agnostic — no Instagram-specific fields.
7. Redis/BullMQ are for async jobs only — PostgreSQL is the single source of truth.
8. Every autonomous decision and action is persisted as structured, queryable data.
9. Modular monolith first — no premature microservices.

## Status

This is Phase 1 of the system described in the project brief: the foundation. Research,
Strategy and Content Planner agents run for real against the orchestrator; Content
Creator, Reviewer, Analytics, Experiment and Community agents are typed skeletons ready
to be implemented. Social platform adapters and the media generator are stubs by design —
see [`docs/social-platforms.md`](docs/social-platforms.md) for what plugs in where.
