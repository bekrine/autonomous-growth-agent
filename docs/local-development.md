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
# 1. create an account
curl -s -X POST http://localhost:4000/api/accounts \
  -H 'Content-Type: application/json' \
  -d '{"userEmail":"demo@example.com","platform":"instagram","externalAccountId":"ig_demo_1","displayName":"Demo Growth Account"}'
# -> { "id": "<accountId>", ... }

# 2. trigger a run
curl -s -X POST http://localhost:4000/api/agent/runs \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"<accountId>"}'
# -> { "runId": "<runId>", "status": "completed" }

# 3. inspect what happened
curl -s http://localhost:4000/api/agent/runs/<runId> | python3 -m json.tool
```

You should see three decisions (`research_completed`, `strategy_proposed`,
`content_idea_planned`) and their corresponding actions, all persisted in Postgres. The
same run also shows up in the dashboard's Agent Activity view (currently backed by mock
data in `apps/web/src/lib/mock-data.ts` — wiring it to this endpoint is the next step).

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

## Kill switch

Setting `AUTONOMY_KILL_SWITCH=true` disables every policy-gated tool call globally at
startup (see `KillSwitchPolicy` in `packages/policies`). It can also be toggled at runtime
per-account or globally via the `KillSwitchStore` the API constructs in
`apps/api/src/config.ts` — no such endpoint is exposed yet, but the mechanism is in place
for one.
