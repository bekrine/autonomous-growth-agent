# Architecture

## Layered flow

```
Frontend (Next.js)
      ↓ HTTP
API (Express: routes → services → repositories)
      ↓
Database (PostgreSQL, source of truth) / Redis (transient job state)
      ↓
Queues (BullMQ: research, strategy, content, publishing, analytics, experiments)
      ↓
Workers (agent-worker, publishing-worker, analytics-worker)
      ↓
Agent Orchestrator (packages/agent-core)
      ↓
Agents (Research, Strategy, ContentPlanner, ... skeletons for the rest)
      ↓
Tools (searchWeb, getAccount, getStrategy, createContentBrief, publishPost, ...)
      ↓
Policies (PolicyEngine: kill switch, content approval, rate limit, platform availability, human approval)
      ↓
External platforms (Instagram/Facebook adapters) / LLM providers / media generators
```

Every arrow above is a hard boundary enforced by TypeScript interfaces, not just a
convention: routes depend on services, services depend on repository classes, agents
depend on a `ToolRouter` (never a repository or an adapter directly), and tools are the
only code allowed to reach into `packages/database` or `packages/social-platforms`.

## Why a modular monolith

The API, the three workers, and the agent-core/database/policies/llm/social-platforms
packages all run as separate Node processes but share one Postgres database and one
Redis instance. This keeps deployment and local development simple (`docker compose up`
starts everything) while still letting workers scale independently of the API. Splitting
into real microservices before there's a concrete scaling reason to would add
coordination cost (service discovery, distributed transactions, versioned contracts)
without a matching benefit — see rule 13/14 in the root README.

## Request/response vs. async paths

Two execution paths exist side by side:

1. **Synchronous demo path**: `POST /api/agent/runs` calls
   `AgentOrchestrator.executeRun()` directly and waits for it to finish before responding.
   This is what makes "trigger a run and see it complete" work today without any queue
   infrastructure in the loop.
2. **Async/outbox path**: business-record writes (e.g. a new `content_posts` row) can also
   write an `outbox_events` row in the same transaction. `OutboxPublisher` (running inside
   `agent-worker`) polls pending outbox rows, publishes each to the matching BullMQ queue,
   and marks it published. Workers then process the queue with (currently placeholder)
   handlers. This is the path real content generation, publishing, and analytics
   collection will run through once implemented, so the orchestrator can eventually kick
   off long-running or externally-rate-limited work without blocking an HTTP request.

Both paths write through the same repositories, so PostgreSQL stays the single source of
truth regardless of which path produced the write.

## Where future features plug in

| Feature | Where it goes |
|---|---|
| Real trend/competitor research | `packages/agent-core/src/tools/search-web.ts` (swap the stub for a real search API) + `ResearchAgent` |
| Real strategy persistence/versioning UI | `apps/api/src/services/strategy.service.ts` + `apps/web/src/app/strategy` |
| Image/video generation | `packages/media` (implement `MediaGenerator` for a real provider) |
| Reviewer approval workflow | `packages/agent-core/src/agents/skeleton-agents.ts` → `ReviewerAgent`, gated by `packages/policies` `ContentApprovalPolicy` |
| Real Instagram/Facebook calls | `packages/social-platforms/src/adapters/*` (implement `SocialPlatform`, no other file needs to change) |
| Comment/community management | `CommunityAgent` + `getComments`/`replyToComment` on `SocialPlatform` |
| A/B experiment analysis | `ExperimentAgent` + `experiments`/`experiment_variants` tables |
| Additional LLM providers (Anthropic, Gemini, local) | `packages/llm/src/providers/*.ts`, implement `LLMProvider` |
| Additional social platforms (TikTok, YouTube, LinkedIn) | New adapter in `packages/social-platforms/src/adapters`, register in `SocialPlatformRegistry` |

None of these require touching `AgentOrchestrator`, the Express route layer, or the
database schema's core shape — that's the point of the abstraction boundaries above.
