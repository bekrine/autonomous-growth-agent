# Database

PostgreSQL is the single source of truth for all persistent business data. Redis/BullMQ
hold only transient job state.

## ORM choice

[Drizzle ORM](https://orm.drizzle.team/) over Prisma:

- Migrations are plain, readable `.sql` files under `migrations/` — easy to review/audit,
  which matters for a system where every autonomous action needs to be traceable.
- No code-generation step gating the build; the schema *is* TypeScript.
- The query builder stays close to SQL, keeping the repository layer thin.

## Schema overview

17 tables, grouped by concern (see `packages/database/src/schema/`):

- **Identity**: `users`, `social_accounts`
- **Strategy**: `agent_profiles`, `agent_goals`, `agent_strategies`, `strategy_versions`
- **Content**: `content_ideas`, `content_posts`, `publishing_jobs`
- **Research**: `research_findings`
- **Measurement**: `analytics_snapshots`, `experiments`, `experiment_variants`
- **Audit trail**: `agent_runs`, `agent_decisions`, `agent_actions`, `outbox_events`

Key design choices:

- `content_posts` is platform-agnostic (`caption`, `mediaUrls: jsonb`, no Instagram/Facebook
  specific fields) — platform rendering concerns live entirely in `packages/social-platforms`.
- `strategy_versions` is append-only; `agent_strategies.currentVersionId` points at the
  latest one. Nothing overwrites a previous strategy version — full history is preserved.
- `agent_decisions`/`agent_actions` are the audit root: every autonomous decision and the
  actions it produced are queryable rows, not log lines.
- `outbox_events` implements the transactional outbox pattern (see `docs/queues.md`).
- `research_findings`, `strategy_versions`, and `content_ideas` all carry a nullable
  `agent_run_id` FK to `agent_runs`. It's both traceability (which run produced this row)
  and the idempotency key the orchestrator checks before writing — see "Transactions and
  idempotency" below.

### Phase 2 additions

- **`research_findings`** (new table): `id, social_account_id, agent_run_id, topic,
  relevance_score, audience_interest_score, competition_score, rationale, source_type,
  created_at`. `source_type` is `"mock"` while research is simulated (see
  `docs/agents.md`); a real provider would write its own source type.
- **`content_ideas`** gained `agent_run_id, format, content_pillar, target_audience, hook,
  objective, priority_score` — the content-brief fields `ContentPlannerAgent` produces. All
  nullable so pre-Phase-2/human-authored ideas remain valid rows.
- **`strategy_versions`** gained `agent_run_id` for the same traceability/idempotency
  reason. `summary` continues to double as the "change summary" field — no separate column
  was added, since the two would always hold the same content (see rule 9 in the root README).

## Repositories

`packages/database/src/repositories/` wraps every table group behind a small class
(`SocialAccountRepository`, `AgentProfileRepository`, `AgentRunRepository`,
`StrategyRepository`, `ContentRepository`, `ResearchRepository`, `AnalyticsRepository`,
`ExperimentRepository`, `OutboxRepository`). Services (in `apps/api`), `AgentRunService`
and `AgentContextLoader` (in `packages/agent-core`) depend on these classes, never on
Drizzle or raw SQL directly — this is what rule #2 in the root README ("no database
queries inside agents") is enforcing structurally, not just by convention.

Every repository constructor accepts `DrizzleClient` (`packages/database/src/client.ts`) —
a union of the top-level `Database` and the transaction-scoped client Drizzle passes into
`db.transaction(async (tx) => ...)`. That's what lets the same repository classes be
reconstructed against a transaction for atomic multi-table writes (see below) without a
separate "transactional repository" class.

## Transactions and idempotency

`AgentOrchestrator` persists each pipeline stage — research, strategy, content planning —
in its own `db.transaction()`, so a stage's decision row, action row, and domain rows
(research_findings / a strategy_versions row / content_ideas rows) either all commit or
none do (per rule 12, "the system must support retries and idempotency," and the
transaction-strategy requirement in the Phase 2 brief).

Idempotency is a read-before-write check inside each transaction, keyed on `agent_run_id`:

- Research: skip the bulk insert if `research_findings` already has rows for this `runId`.
- Strategy: skip creating a new version if `strategy_versions.findVersionByRunId(runId)`
  already returns one.
- Content: skip the bulk insert if `content_ideas.listIdeasByRunId(runId)` is non-empty.

This means calling `AgentOrchestrator.executeRun(accountId, { runId })` twice for the same
`runId` (e.g. a redelivered BullMQ job) re-runs the agents but writes each domain row at
most once. A run already `status: "completed"` short-circuits before re-running the agents
at all.

## Migrations

Schema changes go through Drizzle Kit:

```bash
# from packages/database, after editing src/schema/*.ts
npm run build --workspace=@agent/shared --workspace=@agent/database
npm run db:generate --workspace=@agent/database   # writes a new file to migrations/
npm run db:migrate --workspace=@agent/database     # applies pending migrations
```

`drizzle.config.ts` points `schema` at the **compiled** `dist/schema/index.js` rather than
`src/schema/index.ts`. This project uses `NodeNext` module resolution with explicit `.js`
extensions in relative imports (required for the compiled output to run under Node ESM);
Drizzle Kit's own bundler doesn't resolve those `.js` specifiers back to `.ts` source
files, so it needs the already-compiled JavaScript. Build the package before regenerating
migrations.
