# Queues

## Queue names

Defined once in `packages/shared/src/queues.ts` (`QUEUE_NAMES`) so the API (producer) and
workers (consumers) can't drift:

- `research`
- `strategy`
- `content`
- `publishing`
- `analytics`
- `experiments`

## Who processes what

| Worker | Queues |
|---|---|
| `workers/agent-worker` | `research`, `strategy`, `content`, `experiments` |
| `workers/publishing-worker` | `publishing` |
| `workers/analytics-worker` | `analytics` |

Every processor registered today is a placeholder (`processors.ts` in each worker): it
logs the job and acknowledges it. Real handlers will call into `packages/agent-core`
(re-running a specific agent step, or resuming an `AgentRun`) or `packages/social-platforms`
(for publishing/analytics) once those flows exist.

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
that makes a business fact durable.

## Adding a new queue

1. Add the name to `QUEUE_NAMES` in `packages/shared/src/queues.ts`.
2. Register a `Worker` for it in whichever worker process should own it (or a new worker
   package under `workers/` if it doesn't fit an existing one).
3. If it should be reachable via the outbox, no change needed — `OutboxPublisher` maps
   `aggregateType` → queue name generically via `QUEUE_NAMES`.
