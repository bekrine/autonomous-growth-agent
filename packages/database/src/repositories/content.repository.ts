import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { contentIdeas, contentPosts } from "../schema/index.js";

export class ContentRepository {
  constructor(private readonly db: Database) {}

  async createIdea(input: {
    agentProfileId: string;
    strategyVersionId?: string;
    title: string;
    description?: string;
  }) {
    const [row] = await this.db.insert(contentIdeas).values(input).returning();
    return row;
  }

  async listIdeas(agentProfileId: string) {
    return this.db
      .select()
      .from(contentIdeas)
      .where(eq(contentIdeas.agentProfileId, agentProfileId))
      .orderBy(desc(contentIdeas.createdAt));
  }

  async listPosts(limit = 50) {
    return this.db.select().from(contentPosts).orderBy(desc(contentPosts.createdAt)).limit(limit);
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
