import { desc, eq, sql } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { contentIdeas, contentPosts } from "../schema/index.js";
import type { contentPostStatusEnum } from "../schema/enums.js";

type ContentPostStatus = (typeof contentPostStatusEnum.enumValues)[number];

export interface CreateContentIdeaInput {
  agentProfileId: string;
  strategyVersionId?: string;
  agentRunId?: string;
  title: string;
  description?: string;
  format?: string;
  contentPillar?: string;
  targetAudience?: string;
  hook?: string;
  objective?: string;
  priorityScore?: number;
}

export class ContentRepository {
  constructor(private readonly db: DrizzleClient) {}

  async createIdea(input: CreateContentIdeaInput) {
    const [row] = await this.db
      .insert(contentIdeas)
      .values({ ...input, priorityScore: input.priorityScore?.toString() })
      .returning();
    return row;
  }

  async createIdeas(inputs: CreateContentIdeaInput[]) {
    if (inputs.length === 0) return [];
    return this.db
      .insert(contentIdeas)
      .values(inputs.map((input) => ({ ...input, priorityScore: input.priorityScore?.toString() })))
      .returning();
  }

  async listIdeas(agentProfileId: string) {
    return this.db
      .select()
      .from(contentIdeas)
      .where(eq(contentIdeas.agentProfileId, agentProfileId))
      .orderBy(desc(contentIdeas.createdAt));
  }

  /** Recent ideas for a given agent run — used both for the API response and idempotency checks. */
  async listIdeasByRunId(agentRunId: string) {
    return this.db.select().from(contentIdeas).where(eq(contentIdeas.agentRunId, agentRunId));
  }

  async listPosts(limit = 50) {
    return this.db.select().from(contentPosts).orderBy(desc(contentPosts.createdAt)).limit(limit);
  }

  async listRecentPostsByAccount(socialAccountId: string, limit = 20) {
    return this.db
      .select()
      .from(contentPosts)
      .where(eq(contentPosts.socialAccountId, socialAccountId))
      .orderBy(desc(contentPosts.createdAt))
      .limit(limit);
  }

  async createPost(input: {
    socialAccountId: string;
    contentIdeaId?: string;
    caption?: string;
    mediaUrls?: string[];
    status?: ContentPostStatus;
  }) {
    const [row] = await this.db
      .insert(contentPosts)
      .values({ ...input, mediaUrls: input.mediaUrls ?? [] })
      .returning();
    return row;
  }

  async findIdeaById(id: string) {
    const [row] = await this.db.select().from(contentIdeas).where(eq(contentIdeas.id, id));
    return row ?? null;
  }

  async findPostById(id: string) {
    const [row] = await this.db.select().from(contentPosts).where(eq(contentPosts.id, id));
    return row ?? null;
  }

  async findPostByIdeaId(contentIdeaId: string) {
    const [row] = await this.db.select().from(contentPosts).where(eq(contentPosts.contentIdeaId, contentIdeaId));
    return row ?? null;
  }

  /**
   * `publishedAt` is passed explicitly rather than defaulted to now(), because
   * analytics derives posting hour/day from it — it must be the moment the
   * platform accepted the post, not the moment this row happened to be written.
   */
  async updatePostStatus(id: string, status: ContentPostStatus, options: { publishedAt?: Date } = {}) {
    const [row] = await this.db
      .update(contentPosts)
      .set({
        status,
        ...(options.publishedAt ? { publishedAt: options.publishedAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(contentPosts.id, id))
      .returning();
    return row;
  }

  /** Atomic increment — safe to call concurrently without a read-modify-write race. */
  async incrementGenerationAttempts(id: string) {
    const [row] = await this.db
      .update(contentPosts)
      .set({ generationAttempts: sql`${contentPosts.generationAttempts} + 1`, updatedAt: new Date() })
      .where(eq(contentPosts.id, id))
      .returning();
    return row;
  }

  async setCurrentGenerationVersion(id: string, versionNumber: number) {
    const [row] = await this.db
      .update(contentPosts)
      .set({ currentGenerationVersion: versionNumber, updatedAt: new Date() })
      .where(eq(contentPosts.id, id))
      .returning();
    return row;
  }
}
