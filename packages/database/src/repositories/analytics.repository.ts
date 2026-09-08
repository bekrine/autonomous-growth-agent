import { desc, eq } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { analyticsSnapshots } from "../schema/index.js";

export class AnalyticsRepository {
  constructor(private readonly db: DrizzleClient) {}

  async listForAccount(socialAccountId: string, limit = 100) {
    return this.db
      .select()
      .from(analyticsSnapshots)
      .where(eq(analyticsSnapshots.socialAccountId, socialAccountId))
      .orderBy(desc(analyticsSnapshots.capturedAt))
      .limit(limit);
  }

  async record(input: {
    socialAccountId: string;
    contentPostId?: string;
    metricType: string;
    metrics: Record<string, unknown>;
    capturedAt: Date;
  }) {
    const [row] = await this.db.insert(analyticsSnapshots).values(input).returning();
    return row;
  }
}
