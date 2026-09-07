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

16 tables, grouped by concern (see `packages/database/src/schema/`):

- **Identity**: `users`, `social_accounts`
- **Strategy**: `agent_profiles`, `agent_goals`, `agent_strategies`, `strategy_versions`
- **Content**: `content_ideas`, `content_posts`, `publishing_jobs`
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

## Repositories

`packages/database/src/repositories/` wraps every table group behind a small class
(`SocialAccountRepository`, `AgentRunRepository`, `StrategyRepository`, `ContentRepository`,
`AnalyticsRepository`, `ExperimentRepository`, `OutboxRepository`). Services (in `apps/api`)
and tools (in `packages/agent-core`) depend on these classes, never on Drizzle or raw SQL
directly — this is what rule #2 in the root README ("no database queries inside agents")
is enforcing structurally, not just by convention.

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
