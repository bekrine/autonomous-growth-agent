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
| Image/video generation | `packages/media` (implement `MediaGenerator` for a real provider) |
| Reviewer approval workflow | `packages/agent-core/src/agents/skeleton-agents.ts` → `ReviewerAgent`, gated by `packages/policies` `ContentApprovalPolicy` |
| Real Instagram/Facebook calls | `packages/social-platforms/src/adapters/*` (implement `SocialPlatform`, no other file needs to change) |
| Comment/community management | `CommunityAgent` + `getComments`/`replyToComment` on `SocialPlatform` |
| A/B experiment analysis | `ExperimentAgent` + `experiments`/`experiment_variants` tables |
| Additional LLM providers (Anthropic, Gemini, local) | `packages/llm/src/providers/*.ts`, implement `LLMProvider` |
| Additional social platforms (TikTok, YouTube, LinkedIn) | New adapter in `packages/social-platforms/src/adapters`, register in `SocialPlatformRegistry` |

None of these require touching `AgentOrchestrator`, the Express route layer, or the
database schema's core shape — that's the point of the abstraction boundaries above.
