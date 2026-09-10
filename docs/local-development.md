# Local development

## Option A — Docker Compose (everything)

```bash
cp .env.example .env
docker compose up
```

This starts `postgres`, `redis`, `api`, `web`, `agent-worker`, `publishing-worker`, and
`analytics-worker`. Postgres and Redis data persist in named volumes (`pgdata`,
`redisdata`). All services join the default compose network and reach each other by
service name (`postgres`, `redis`, `api`).

Migrations are **not** run automatically by `docker compose up` in this phase — run them
once against the containerized Postgres:

```bash
DATABASE_URL=postgresql://agent:agent@localhost:5432/agent_growth \
  npm run db:migrate --workspace=@agent/database
```

Optionally seed one realistic dev account (niche, audience, goal) so there's something to
run agents against immediately — idempotent, safe to re-run, never invoked automatically:

```bash
DATABASE_URL=postgresql://agent:agent@localhost:5432/agent_growth \
REDIS_URL=redis://localhost:6379 \
  npm run db:seed --workspace=@agent/database
```

Then:

```bash
curl http://localhost:4000/api/health
# {"status":"ok","database":"up","redis":"up",...}
```

## Option B — Run natively (faster inner loop)

```bash
cp .env.example .env
docker compose up -d postgres redis
npm install
npm run build --workspace=@agent/shared --workspace=@agent/database
npm run db:generate --workspace=@agent/database   # first time only, or after schema changes
npm run db:migrate --workspace=@agent/database

npm run dev:api               # apps/api, tsx watch, port 4000
npm run dev:web               # apps/web, next dev, port 3000
npm run dev:agent-worker      # workers/agent-worker
npm run dev:publishing-worker
npm run dev:analytics-worker
```

## Verifying the whole path

```bash
# 1. create an account — niche is what makes it immediately runnable (creates an agent_profile)
curl -s -X POST http://localhost:4000/api/accounts \
  -H 'Content-Type: application/json' \
  -d '{"userEmail":"demo@example.com","platform":"instagram","externalAccountId":"ig_demo_1","displayName":"Demo Growth Account","niche":"AI and developer productivity","targetAudience":"developers","goalTitle":"Grow an educational account","goalMetric":"followers"}'
# -> { "id": "<accountId>", ... }

# 2. trigger a run (synchronous — waits for the full pipeline to finish)
curl -s -X POST http://localhost:4000/api/agent/runs \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"<accountId>"}'
# -> { "runId": "<runId>", "status": "completed", "research": [...], "strategy": {...}, "contentIdeas": [...] }

# 2b. or trigger the same run through BullMQ instead
curl -s -X POST http://localhost:4000/api/agent/runs/queue \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"<accountId>"}'
# -> { "status": "queued", "jobId": "..." } — agent-worker logs will show it complete

# 3. inspect what happened
curl -s http://localhost:4000/api/agent/runs/<runId> | python3 -m json.tool
```

You should see three decisions (`research_topics_discovered`, `strategy_updated` or
`strategy_unchanged`, `content_ideas_planned`) and their corresponding actions, plus the
`research`/`strategy`/`contentIdeas` rows they produced, all persisted in Postgres. The
same run is visible in the dashboard's **Agent Activity** page — pick the account and
click **Start Agent Run**; the panel calls the real API, no mock data involved.

With no LLM key set, every field the model would normally fill in reads `"mock value"` —
that's `MockLLMProvider` faking a schema-valid response so the whole pipeline (context
loading → prompts → validation → persistence) is exercisable for free. For real reasoning,
set **either** `HF_TOKEN` (Hugging Face, free tier — takes priority) or `OPENAI_API_KEY`.

## Generating content (Phase 3)

Continuing from the run above — pick one of the `contentIdeas[].id` values it returned:

```bash
# Synchronous: runs ContentCreator → media → Reviewer and waits for the verdict.
curl -s -X POST http://localhost:4000/api/content/<contentIdeaId>/generate | python3 -m json.tool
# -> { "contentId": "...", "status": "ready_for_publishing", "generationVersion": 1,
#      "generation": { "format": "reel", "hook": "...", "script": [...], "caption": "...",
#                      "assets": [...], "review": { "approved": true, "score": 0.95 } } }

# Or queue it (agent-worker picks it up; same AgentRunService either way):
curl -s -X POST http://localhost:4000/api/content/<contentIdeaId>/generate/queue

# Read current state and the full version history:
curl -s http://localhost:4000/api/content/<contentId>          | python3 -m json.tool
curl -s http://localhost:4000/api/content/<contentId>/versions | python3 -m json.tool
```

The same flow is driven from the dashboard's **Content** page: *1. Plan content ideas* →
pick an idea → *2. Generate content*, then inspect the generated copy, media, caption/CTA/
alt text, review scores and generation history.

A rejected review triggers automatic regeneration with the reviewer's `recommendedChanges`
folded into the next prompt, up to `MAX_CONTENT_GENERATION_ATTEMPTS` (default 3), after
which the content lands in `review_failed` for a human to look at. Every attempt is kept as
its own `content_generations` row — nothing is overwritten.

### Real image generation

Off by default, because Hugging Face's free tier no longer serves text-to-image (their
`hf-inference` provider returns 410 for these models), so it needs Inference Provider
credits. Left off, `MockImageGenerator` produces a placeholder SVG explicitly labeled
"MOCK IMAGE (not AI-generated)". To enable:

```env
IMAGE_GENERATION_ENABLED=true
HF_IMAGE_PROVIDER=fal-ai
HF_IMAGE_MODEL=black-forest-labs/FLUX.1-schnell
```

A media failure never fails the whole generation — the asset row records `failed` and the
Reviewer still evaluates the copy.

## Tests

```bash
npm run typecheck   # tsc -b across all workspace packages
npm test            # vitest across every package/app with a test script
```

Repository tests that need a live database (`packages/database/src/__tests__`) detect
whether Postgres is reachable and skip automatically otherwise, so `npm test` stays green
on a bare checkout with no infra running.

## Environment variables

See `.env.example`. Every process validates its environment at startup via
`loadEnv()` in `packages/shared/src/env.ts` and fails fast with a readable list of
missing/invalid variables rather than failing deep in an unrelated code path later.

`LLM_MODEL` (default `gpt-4o-mini`) and `LLM_MAX_RETRIES` (default `3`) configure
`OpenAIProvider` — used for both `generateText` and `generateStructured`. Neither is
hard-coded; both flow through `createLLMProvider()` in `packages/llm`.

## Kill switch

Setting `AUTONOMY_KILL_SWITCH=true` disables every policy-gated tool call globally at
startup (see `KillSwitchPolicy` in `packages/policies`). It can also be toggled at runtime
per-account or globally via the `KillSwitchStore` the API constructs in
`apps/api/src/config.ts` — no such endpoint is exposed yet, but the mechanism is in place
for one.
