import type { Database, StrategyRepository } from "@agent/database";
import { schema } from "@agent/database";
import { eq } from "drizzle-orm";

export class StrategyService {
  constructor(
    private readonly repo: StrategyRepository,
    private readonly db: Database,
  ) {}

  async getForAccount(accountId: string) {
    const [profile] = await this.db
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.socialAccountId, accountId));
    if (!profile) return [];
    return this.repo.findByAgentProfileId(profile.id);
  }

  async createStrategy(input: { agentProfileId: string; name: string }) {
    const [row] = await this.db.insert(schema.agentStrategies).values(input).returning();
    return row;
  }
}
