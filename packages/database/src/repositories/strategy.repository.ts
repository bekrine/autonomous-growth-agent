import { asc, desc, eq } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { agentStrategies, strategyVersions } from "../schema/index.js";

export class StrategyRepository {
  constructor(private readonly db: DrizzleClient) {}

  async findByAgentProfileId(agentProfileId: string) {
    return this.db
      .select()
      .from(agentStrategies)
      .where(eq(agentStrategies.agentProfileId, agentProfileId));
  }

  async create(input: { agentProfileId: string; name: string }) {
    const [row] = await this.db.insert(agentStrategies).values(input).returning();
    return row;
  }

  async createVersion(input: {
    strategyId: string;
    versionNumber: number;
    summary: string;
    content: Record<string, unknown>;
    createdBy: string;
    agentRunId?: string;
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

  /** Full, append-only version history — oldest first, for auditability. */
  async listVersions(strategyId: string) {
    return this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, strategyId))
      .orderBy(asc(strategyVersions.versionNumber));
  }

  /** Idempotency check: has this run already produced a strategy version? */
  async findVersionByRunId(agentRunId: string) {
    const [row] = await this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.agentRunId, agentRunId));
    return row ?? null;
  }
}
