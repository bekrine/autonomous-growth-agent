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

20 tables, grouped by concern (see `packages/database/src/schema/`):

- **Identity**: `users`, `social_accounts`
- **Strategy**: `agent_profiles`, `agent_goals`, `agent_strategies`, `strategy_versions`
- **Content**: `content_ideas`, `content_posts`, `publishing_jobs`
- **Content generation**: `content_generations`, `content_reviews`, `content_assets`
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

### Phase 3 additions (content generation)

Three new tables, all hanging off `content_posts`:

- **`content_generations`** — one row per ContentCreatorAgent attempt:
  `content_post_id, version_number, attempt_number, format, payload (jsonb), status,
  error_message, agent_run_id, llm_provider, llm_model, duration_ms, prompt_tokens,
  completion_tokens, created_at`. **Append-only** — v1/v2/v3 are all preserved so the
  future learning system can compare which generated version performed best.
  `UNIQUE (content_post_id, version_number)` is the idempotency key.
- **`content_reviews`** — one row per generation (`UNIQUE content_generation_id`):
  `approved, score, quality_score, brand_score, safety_score, issues, warnings,
  recommended_changes`. Re-reviewing means generating a *new* version, never overwriting.
- **`content_assets`** — asset **metadata only**: `asset_type, storage_key, url, mime_type,
  provider, storage_provider, size_bytes, provider_asset_id, width, height,
  duration_seconds, status, error_message`. The bytes live in object storage
  (`packages/media`'s `ObjectStorage` — Cloudflare R2 in production), never in Postgres.
  `provider` is the *generator* that produced the bytes (`mock`, `huggingface`);
  `storage_provider` is the *ObjectStorage* holding them (`cloudflare-r2`, `local-disk`).
  They answer different questions and change independently, which is why they are separate
  columns (added in `0005_furry_valkyrie.sql`). `mime_type` describes the object as
  **stored** — i.e. after SVG→JPEG conversion — so it always matches what a fetcher gets.
  See [`storage.md`](storage.md).

`content_posts` also gained `current_generation_version` and `generation_attempts`
(denormalized for cheap reads; `content_generations` remains the source of truth), and
`content_idea_id` became `UNIQUE` so "find or create the post for this idea" is a single
idempotent lookup.

### Content lifecycle

`content_post_status` gained the Phase 3 states, appended non-destructively via
`ALTER TYPE ... ADD VALUE` so no existing rows were rewritten:

```
idea → brief_created → generating → generated → reviewing → ready_for_publishing
                            ↓                        ↓
                    generation_failed          review_failed
```

`review_failed` means the regeneration budget (`MAX_CONTENT_GENERATION_ATTEMPTS`,
default 3) was exhausted and a human should look.

Media assets have their own lifecycle: `requested → generating → completed | failed`.

Phase 4 continues the post lifecycle past `ready_for_publishing`:

```
ready_for_publishing → queued | scheduled → publishing → published
                                                 ↓
                                         (job failed; post returns to
                                          ready_for_publishing for retry)
```

### Phase 4 additions (social connections and publishing)

- **`social_connections`** — an authorized link to a real platform account:
  `social_account_id, platform, platform_account_id, platform_username, account_type,
  access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, status,
  last_error, metadata`. Tokens are **AES-256-GCM ciphertext**
  (`packages/shared/src/crypto.ts`), never plaintext, and repositories expose a
  `SafeSocialConnection` projection that omits them — only `findByIdWithSecrets()` returns
  the ciphertext, and only `PublishingService` calls it.
  `UNIQUE (platform, platform_account_id)` makes reconnecting the same Instagram account
  an update rather than a duplicate.
  Disconnecting calls `revoke()`, which sets `status = 'revoked'` and **nulls the stored
  ciphertext** while keeping the row, so historical `publishing_jobs` still resolve to the
  account they published to. That is why `access_token_encrypted` is nullable
  (`0004_massive_zombie.sql`).
- **`oauth_states`** — short-lived CSRF state for the OAuth handshake: `state` (UNIQUE),
  `social_account_id`, `redirect_uri`, `expires_at`. Consumed single-use. The account id
  is read back **from this row**, never from the callback query string, so a forged
  callback cannot attach a connection to someone else's account.
- **`publishing_jobs`** gained `content_generation_id, social_connection_id, platform,
  idempotency_key (UNIQUE), external_container_id, external_post_id, error_code,
  published_at`.

`external_container_id` is stored separately from `external_post_id` because Meta's flow
has two ids: the container created first, and the media id returned by `media_publish`.
Recording the container makes a crash mid-flow diagnosable.

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

### Phase 5 additions (analytics)

- **`analytics_snapshots`** gained `content_generation_id, social_connection_id, platform,
  external_post_id, collection_window, outcome, error_reason`. Append-only: rows are never
  updated, so "current followers" is the newest snapshot rather than a mutated field and
  follower history survives. `metrics` holds the *sanitized* raw provider payload; the
  normalized numbers live in `analytics_metrics`, so a normalization bug can be diagnosed
  after the fact instead of being baked in.
- **`analytics_metrics`** — one row per measurement: `metric_name` (canonical),
  `platform_metric_name` (what the API called it), `metric_value`, `metric_unit`,
  `available`, `unavailable_reason`, `source` (`platform` | `derived`), `computation`.
  Metrics as rows rather than columns means a new platform metric needs **no migration** —
  which matters because Meta's set changes (impressions → views, April 2025).
  `available = false` is categorically different from `value = 0`; see
  [`analytics.md`](analytics.md).
- **`content_analytics_state`** — per-post collection state: `status`, `published_at`,
  `last_snapshot_at`, `next_snapshot_at`, `completed_windows`, `attempts`, `last_error`.
  This is the cost control: the worker selects only posts whose `next_snapshot_at` has
  arrived instead of polling everything published.
- **`analytics_insights`** — structured AnalyticsAgent observations with evidence,
  confidence, sample size and time range. Deliberately separate from `strategy_versions`:
  Phase 5 measures and explains, it does not change strategy.
- **`content_posts`** gained nullable `experiment_id` / `experiment_variant_id`. No
  experiment logic reads them yet (Phase 6), but carrying them now means posts published
  during Phase 5 can still be attributed later, instead of leaving a blind spot.

Analytics idempotency is enforced by:

```sql
UNIQUE NULLS NOT DISTINCT (social_account_id, content_post_id, metric_type, collection_window)
```

`NULLS NOT DISTINCT` (migration `0007`) is essential rather than decorative: account-level
snapshots have a NULL `content_post_id`, and Postgres's default treats every NULL as
distinct — so without it the same account/day could insert repeatedly and silently corrupt
follower history.

### Phase 6 additions (experiments)

- **`experiments`** gained `social_account_id`, `variable`, `primary_metric`,
  `secondary_metrics`, `min_samples_per_variant`, `observation_window_hours`,
  `max_duration_days`, `min_relative_lift`, `proposed_by_agent_run_id` and
  `status_reason`. The design config is **frozen onto the row at creation**, so an
  experiment is judged by the rules it was designed with — changing a default later cannot
  retroactively turn a past `inconclusive` into a `winner`.
- **`experiment_variants`** gained `role` (`control`|`variant`), `variable_value`,
  `description`, `status` and `target_sample_size`. The variant→posts link is
  `content_posts.experiment_variant_id` (added in Phase 5), not the legacy 1:1
  `content_post_id` — an arm needs many posts to reach its sample size.
- **`experiment_evaluations`** is new and **append-only**: every evaluation is a row, so a
  conclusion can be audited against the data behind it. `UNIQUE (experiment_id,
  evaluation_key)` makes re-evaluating unchanged data a no-op rather than a duplicate
  conclusion; the key is derived from the primary metric and each arm's observation count.
- **`experiment_status`** extended non-destructively from 4 to 10 values via
  `ALTER TYPE ... ADD VALUE` (migration `0008`).

See [`experiments.md`](experiments.md).

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

Content generation (`AgentOrchestrator.generateContent`) uses the same approach, keyed on
`(content_post_id, version_number)` instead:

- The content post is found-or-created by `content_idea_id` (which is `UNIQUE`), so one
  idea never spawns two posts.
- A post already in a terminal state (`ready_for_publishing` / `review_failed`)
  short-circuits before any LLM call.
- Each generation attempt checks `findByPostIdAndVersion` before inserting, and each
  review checks `findReviewByGenerationId` — both backed by real `UNIQUE` constraints, so
  a concurrent duplicate fails at the database rather than silently double-writing.

Publishing (Phase 4) raises the bar, because the side effect is irreversible: a duplicate
row is recoverable, a duplicate Instagram post is not. So neither guard is a
read-before-write check — both are enforced by the database itself:

- **Enqueue** inserts with `ON CONFLICT (idempotency_key) DO NOTHING` and reports whether
  a row was actually created. Two simultaneous publish requests for the same
  (post, generation) produce one job.
- **Execute** claims the job with a conditional
  `UPDATE ... SET status='publishing' WHERE status IN ('queued','scheduled','retry_scheduled')`.
  Only one caller can observe the row transition; a redelivered BullMQ job or a second
  worker claims nothing and returns `skipped`. A `published` job can never be re-claimed,
  which is the property that makes queue retries safe.

Read-before-write would not be sufficient here: two workers could both read `queued` and
both proceed. The conditional UPDATE collapses the check and the write into one atomic
statement.

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
