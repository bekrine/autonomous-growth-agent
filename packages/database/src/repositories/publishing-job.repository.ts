import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { publishingJobs } from "../schema/index.js";
import type { publishingJobStatusEnum } from "../schema/enums.js";

export type PublishingJobStatus = (typeof publishingJobStatusEnum.enumValues)[number];

export interface CreatePublishingJobInput {
  contentPostId: string;
  contentGenerationId?: string;
  socialConnectionId: string;
  platform: "instagram" | "facebook";
  idempotencyKey: string;
  scheduledFor?: Date;
  status: PublishingJobStatus;
}

export class PublishingJobRepository {
  constructor(private readonly db: DrizzleClient) {}

  /**
   * Idempotent create: `idempotencyKey` is UNIQUE, so a duplicate publish
   * request returns the existing job rather than creating a second one that
   * could publish the same content twice.
   */
  async createIfAbsent(input: CreatePublishingJobInput) {
    const [row] = await this.db
      .insert(publishingJobs)
      .values(input)
      .onConflictDoNothing({ target: publishingJobs.idempotencyKey })
      .returning();
    if (row) return { job: row, created: true as const };

    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (!existing) throw new Error(`Publishing job upsert raced without a resolvable row: ${input.idempotencyKey}`);
    return { job: existing, created: false as const };
  }

  async findByIdempotencyKey(idempotencyKey: string) {
    const [row] = await this.db
      .select()
      .from(publishingJobs)
      .where(eq(publishingJobs.idempotencyKey, idempotencyKey));
    return row ?? null;
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(publishingJobs).where(eq(publishingJobs.id, id));
    return row ?? null;
  }

  async listRecent(limit = 100) {
    return this.db.select().from(publishingJobs).orderBy(desc(publishingJobs.createdAt)).limit(limit);
  }

  async listByContentPost(contentPostId: string) {
    return this.db
      .select()
      .from(publishingJobs)
      .where(eq(publishingJobs.contentPostId, contentPostId))
      .orderBy(desc(publishingJobs.createdAt));
  }

  /** Any already-successful publish for this post — the guard against double-posting. */
  async findSucceededForContentPost(contentPostId: string) {
    const [row] = await this.db
      .select()
      .from(publishingJobs)
      .where(
        and(
          eq(publishingJobs.contentPostId, contentPostId),
          eq(publishingJobs.status, "published"),
          isNotNull(publishingJobs.externalPostId),
        ),
      );
    return row ?? null;
  }

  async updateStatus(
    id: string,
    update: {
      status: PublishingJobStatus;
      errorCode?: string | null;
      lastError?: string | null;
      externalContainerId?: string | null;
      externalPostId?: string | null;
      publishedAt?: Date | null;
      scheduledFor?: Date | null;
    },
  ) {
    const [row] = await this.db
      .update(publishingJobs)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(publishingJobs.id, id))
      .returning();
    return row;
  }

  /** Atomic increment so concurrent workers can't both read-modify-write the same count. */
  async incrementAttempts(id: string) {
    const [row] = await this.db
      .update(publishingJobs)
      .set({ attempts: sql`${publishingJobs.attempts} + 1`, updatedAt: new Date() })
      .where(eq(publishingJobs.id, id))
      .returning();
    return row;
  }

  /**
   * Claims a job for processing only if it's still in a startable state.
   * The conditional UPDATE is the concurrency guard: a cancelled job, or one
   * another worker already claimed, matches zero rows and returns null.
   */
  async claimForPublishing(id: string) {
    const [row] = await this.db
      .update(publishingJobs)
      .set({ status: "publishing", updatedAt: new Date() })
      .where(
        and(
          eq(publishingJobs.id, id),
          sql`${publishingJobs.status} IN ('queued', 'scheduled', 'retry_scheduled')`,
        ),
      )
      .returning();
    return row ?? null;
  }

  async cancel(id: string) {
    const [row] = await this.db
      .update(publishingJobs)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(eq(publishingJobs.id, id), sql`${publishingJobs.status} IN ('queued', 'scheduled', 'retry_scheduled')`),
      )
      .returning();
    return row ?? null;
  }

  /** Successful publishes since `since` — backs the internal rate-limit policy. */
  async countPublishedSince(socialConnectionId: string, since: Date) {
    const rows = await this.db
      .select({ id: publishingJobs.id })
      .from(publishingJobs)
      .where(
        and(
          eq(publishingJobs.socialConnectionId, socialConnectionId),
          eq(publishingJobs.status, "published"),
          gte(publishingJobs.publishedAt, since),
        ),
      );
    return rows.length;
  }

  async findLastPublished(socialConnectionId: string) {
    const [row] = await this.db
      .select()
      .from(publishingJobs)
      .where(
        and(eq(publishingJobs.socialConnectionId, socialConnectionId), eq(publishingJobs.status, "published")),
      )
      .orderBy(desc(publishingJobs.publishedAt))
      .limit(1);
    return row ?? null;
  }
}
