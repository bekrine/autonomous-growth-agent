import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { agentStrategies, strategyVersions } from "../schema/index.js";

export class StrategyRepository {
  constructor(private readonly db: Database) {}

  async findByAgentProfileId(agentProfileId: string) {
    return this.db
      .select()
      .from(agentStrategies)
      .where(eq(agentStrategies.agentProfileId, agentProfileId));
  }

  async createVersion(input: {
    strategyId: string;
    versionNumber: number;
    summary: string;
    content: Record<string, unknown>;
    createdBy: string;
  }) {
    const [row] = await this.db.insert(strategyVersions).values(input).returning();
    await this.db
      .update(agentStrategies)
      .set({ currentVersionId: row.id, updatedAt: new Date() })
      .where(eq(agentStrategies.id, input.strategyId));
    return row;
  }

  async latestVersion(strategyId: string) {
    const [row] = await this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, strategyId))
      .orderBy(desc(strategyVersions.versionNumber))
      .limit(1);
    return row ?? null;
  }
}
