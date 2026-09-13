# Queues

## Queue names

Defined once in `packages/shared/src/queues.ts` (`QUEUE_NAMES`) so the API (producer) and
workers (consumers) can't drift:

- `research`, `strategy` — per-stage placeholder queues (Phase 1), unused by the real
  flows so far.
- `experiments` — **real** (Phase 6). Checks experiment progress and runs evaluation.
- `analytics` — **real** (Phase 5). Schedules and performs bounded metric collection.
- `publishing` — **real** (Phase 4). Publishes one approved content post to a connected
  platform account.
- `agent-run` — runs the full Research → Strategy → ContentPlanner pipeline for one
  account, via the exact same `AgentRunService` the API calls synchronously.
- `content` — **real** (Phase 3). Its `generate-content` job runs
  ContentCreator → media generation → Reviewer for one content idea.

## Who processes what

| Worker | Queues |
|---|---|
| `workers/agent-worker` | `research`, `strategy` (placeholders), `agent-run`, `content`, `experiments` (real) |
| `workers/publishing-worker` | `publishing` (real) |
| `workers/analytics-worker` | `analytics` (real) |

The remaining per-stage queues still run placeholder processors (`processors.ts`): they log
the job and acknowledge it. `agent-run`, `content`, `publishing` and `analytics` are fully
implemented — see below.

## The `experiments` queue

| Job | Effect |
|---|---|
| `check-experiment-progress` | Evaluates **only** once every arm has met its sample target |
| `evaluate-experiment` | Evaluates immediately |

```
BullMQ job { experimentId }
      ↓
createExperimentProcessor (job plumbing only — no experiment logic)
      ↓
ExperimentService.getProgress() / .evaluate()
```

Concurrency is 1: two concurrent evaluations of the same experiment would race for the
same idempotency key. `check-experiment-progress` deliberately does nothing while arms are
short, rather than recording an "insufficient data" row on every tick. See
[`experiments.md`](experiments.md).

## The `analytics` queue

Two job kinds share it:

```
content.published    ← emitted by PublishingService through the outbox on a successful
                       publish; registers the post for collection
collect-analytics    ← one bounded collection pass; with no contentPostId it sweeps
                       everything currently due
```

```
BullMQ job
      ↓
createAnalyticsProcessor (job plumbing only — no metric logic, no Meta calls)
      ↓
AnalyticsService.schedulePostCollection() | .collectForPost()
      ↓
InstagramAnalyticsProvider → Meta Graph API
```

The sweep is a **repeatable BullMQ job** (`ANALYTICS_SWEEP_INTERVAL_MINUTES`, default 15),
registered with a stable `jobId` so re-registering on boot updates the schedule instead of
stacking duplicates. `setInterval`/`setTimeout` are deliberately not used: the cadence must
survive a restart, and several worker replicas must not each run their own timer.

Three things keep this from storming the Meta API: worker concurrency defaults to 1, only
posts whose `next_snapshot_at` has arrived are selected, and the per-post collection ladder
is finite. See [`analytics.md`](analytics.md).

A failed collection is **not** a job failure — `AnalyticsService` has already recorded the
outcome and decided whether another attempt is worthwhile, so throwing would add a second,
uncoordinated retry loop on top of it.

## The `publishing` queue

`PublishingService.enqueue()` writes a `publishing_jobs` row and an `outbox_events` row in
one transaction; `OutboxPublisher` then moves it onto this queue.
`workers/publishing-worker/src/publishing-processor.ts` consumes it:

```
BullMQ job { publishingJobId }
        ↓
createPublishingProcessor (job plumbing only — no business logic)
        ↓
PublishingService.execute(publishingJobId)
   claim → re-evaluate policy → decrypt token → adapter.publish() → persist
```

Two safeguards make redelivery harmless, and both live in the **database** rather than in
app-level bookkeeping:

- `publishing_jobs.idempotency_key` is UNIQUE, so a repeated enqueue for the same
  (post, generation) returns the existing job instead of creating a second one.
- `claimForPublishing()` is a conditional `UPDATE ... WHERE status IN
  ('queued','scheduled','retry_scheduled')`. Two workers racing the same job means exactly
  one claim succeeds; the loser does nothing. A job already `published` can never be
  re-claimed.

The processor throws (letting BullMQ retry) **only** when the resulting status is
`retry_scheduled`. A permanent failure — bad credentials, invalid media, policy denial — is
a terminal outcome recorded on the row, not a job failure, so BullMQ does not retry it and
attempts are not burned. Retries are additionally bounded by `MAX_PUBLISH_ATTEMPTS`.

Scheduled posts carry a persisted `scheduled_for` timestamp that `execute()` checks; a job
that isn't due yet is declined by policy rather than slept on. Nothing uses `setTimeout`,
so restarting the stack cannot lose a scheduled post.

> **Testing gotcha:** the integration tests drive `PublishingService` directly against the
> same Postgres/Redis. If a local publishing-worker is running, it will consume the tests'
> outbox events and race them, producing confusing order-dependent failures. Stop local
> workers before running the suite.

## The `content` queue

`POST /api/content/:ideaId/generate/queue` (`ContentQueueProducer`) adds a
`generate-content` job with `{ accountId, contentIdeaId }` and returns
`{ status: "queued", jobId }` immediately, instead of running synchronously like
`POST /api/content/:ideaId/generate`.

`workers/agent-worker/src/content-generation-processor.ts` consumes it:

```
BullMQ job { accountId, contentIdeaId, runId? }
        ↓
createContentGenerationProcessor (job plumbing only — no business logic)
        ↓
AgentRunService.generateContent(accountId, contentIdeaId)
  or .resumeContentGeneration(accountId, contentIdeaId, runId)
        ↓
AgentOrchestrator.generateContent(...)   // ContentCreator → media → Reviewer, with regeneration loop
```

Same rule as `agent-run`: the processor contains no generation logic, so "generate content
for an idea" has exactly one implementation regardless of whether the API or the queue
triggered it. A redelivered job is safe — see the idempotency notes in `docs/database.md`.
The processor only throws (letting BullMQ retry) on `generation_failed`; `review_failed` is
a legitimate terminal outcome, not a job failure, so it is not retried.

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
