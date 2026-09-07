import { Queue } from "bullmq";
import type { OutboxRepository } from "@agent/database";
import type { Logger, QueueName, RedisConnection } from "@agent/shared";
import { QUEUE_NAMES } from "@agent/shared";

/**
 * Polls outbox_events for pending rows and publishes each onto the BullMQ
 * queue matching its aggregateType, then marks it published. This is the
 * bridge between "Database transaction commits a business record" and
 * "a worker eventually picks up the async follow-on work" — Redis is never
 * the source of truth, only the delivery mechanism.
 */
export class OutboxPublisher {
  private readonly queues: Map<QueueName, Queue>;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly outboxRepository: OutboxRepository,
    connection: RedisConnection,
    private readonly logger: Logger,
    private readonly intervalMs = 2000,
  ) {
    this.queues = new Map(QUEUE_NAMES.map((name) => [name, new Queue(name, { connection })]));
  }

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger.error({ err: error instanceof Error ? error.message : error }, "outbox.tick_failed");
      });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }

  private async tick(): Promise<void> {
    const pending = await this.outboxRepository.listPending();
    for (const event of pending) {
      const queue = this.queues.get(event.aggregateType as QueueName);
      if (!queue) {
        this.logger.warn({ eventId: event.id, aggregateType: event.aggregateType }, "outbox.unknown_queue");
        await this.outboxRepository.markFailed(event.id);
        continue;
      }
      await queue.add(event.eventType, event.payload);
      await this.outboxRepository.markPublished(event.id);
      this.logger.info({ eventId: event.id, queue: event.aggregateType }, "outbox.published");
    }
  }
}
