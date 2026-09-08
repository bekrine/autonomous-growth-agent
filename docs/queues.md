# Queues

## Queue names

Defined once in `packages/shared/src/queues.ts` (`QUEUE_NAMES`) so the API (producer) and
workers (consumers) can't drift:

- `research`, `strategy`, `content`, `publishing`, `analytics`, `experiments` — per-stage
  placeholder queues (Phase 1), unused by the Phase 2 agent-run flow directly.
- `agent-run` — runs the full Research → Strategy → ContentPlanner pipeline for one
  account, via the exact same `AgentRunService` the API calls synchronously.

## Who processes what

| Worker | Queues |
|---|---|
| `workers/agent-worker` | `research`, `strategy`, `content`, `experiments` (placeholders), `agent-run` (real) |
| `workers/publishing-worker` | `publishing` |
| `workers/analytics-worker` | `analytics` |

The four per-stage queues still run placeholder processors (`processors.ts`): they log the
job and acknowledge it. `agent-run` is fully implemented — see below.

## The `agent-run` queue

`POST /api/agent/runs/queue` (`AgentQueueProducer.enqueueRun`, `apps/api/src/services/`)
adds a `run-agent` job with `{ accountId }` and returns `{ status: "queued", jobId }`
immediately, instead of running synchronously like `POST /api/agent/runs`.

`workers/agent-worker/src/agent-run-processor.ts` consumes it:

```
BullMQ job { accountId, runId? }
        ↓
createAgentRunProcessor (job plumbing only — no business logic)
        ↓
AgentRunService.startRun(accountId)          // no runId: new run
  or .resumeRun(accountId, runId)            // runId present: resume/retry
        ↓
AgentOrchestrator.executeRun(...)
```

`AgentRunService` (`packages/agent-core/src/agent-run-service.ts`) is framework-agnostic —
`apps/api`'s routes and `workers/agent-worker`'s job processor both get their instance from
`buildAgentSystem()` and call the same methods. Neither reimplements "start a run" or
"shape a run's result" — this is what section 24 ("Do NOT duplicate business logic inside
the worker") requires, enforced by having exactly one class capable of it.

If a job is redelivered (BullMQ retry, worker crash mid-job) with the same `runId`,
`AgentOrchestrator`'s per-stage idempotency checks (see `docs/database.md`) mean re-running
it does not create duplicate research/strategy/content rows; a run already `completed`
short-circuits before any agent re-runs.

Trigger one manually against a running stack:

```bash
curl -X POST http://localhost:4000/api/agent/runs/queue \
  -H 'Content-Type: application/json' \
  -d '{"accountId": "<uuid>"}'
```

## Outbox → queue bridge

`workers/agent-worker/src/outbox-publisher.ts` runs an `OutboxPublisher` alongside the
BullMQ workers in the same process:

1. Polls `outbox_events` for rows with `status = 'pending'` (via `OutboxRepository`).
2. For each row, looks up the BullMQ queue matching `aggregateType` and calls
   `queue.add(eventType, payload)`.
3. Marks the row `published` (or `failed` if `aggregateType` doesn't match a known queue).

This means a business-record write and its outbox row commit atomically in one Postgres
transaction, and the actual Redis/BullMQ publish happens afterward, asynchronously, with
retries handled by re-polling — Redis is never in the critical path of the transaction
that makes a business fact durable. (The `agent-run` queue is *not* driven by the outbox —
it's produced directly by the API/producer, since a run is user-triggered, not a
side-effect of another write.)

## Adding a new queue

1. Add the name to `QUEUE_NAMES` in `packages/shared/src/queues.ts`.
2. Register a `Worker` for it in whichever worker process should own it (or a new worker
   package under `workers/` if it doesn't fit an existing one).
3. If it should be reachable via the outbox, no change needed — `OutboxPublisher` maps
   `aggregateType` → queue name generically via `QUEUE_NAMES`.
