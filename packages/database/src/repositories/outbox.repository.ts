import { and, eq } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { outboxEvents } from "../schema/index.js";

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Outbox writes must happen in the same transaction as the business record
 * they describe — callers should pass a transaction-scoped `db` (e.g. from
 * `db.transaction(async (tx) => ...)`) when writing both together.
 */
export class OutboxRepository {
  constructor(private readonly db: DrizzleClient) {}

  async enqueue(event: OutboxEventInput) {
    const [row] = await this.db.insert(outboxEvents).values(event).returning();
    return row;
  }

  async listPending(limit = 100) {
    return this.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.status, "pending"))
      .limit(limit);
  }

  async markPublished(id: string) {
    await this.db
      .update(outboxEvents)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(outboxEvents.id, id));
  }

  async markFailed(id: string) {
    await this.db
      .update(outboxEvents)
      .set({ status: "failed" })
      .where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, "pending")));
  }
}
