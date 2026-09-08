import { desc, eq } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { contentIdeas, contentPosts } from "../schema/index.js";

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
  }) {
    const [row] = await this.db
      .insert(contentPosts)
      .values({ ...input, mediaUrls: input.mediaUrls ?? [] })
      .returning();
    return row;
  }
}
