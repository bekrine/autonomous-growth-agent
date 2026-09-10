import { and, desc, eq } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { agentGoals, agentProfiles } from "../schema/index.js";

export class AgentProfileRepository {
  constructor(private readonly db: DrizzleClient) {}

  async findBySocialAccountId(socialAccountId: string) {
    const [row] = await this.db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.socialAccountId, socialAccountId));
    return row ?? null;
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(agentProfiles).where(eq(agentProfiles.id, id));
    return row ?? null;
  }

  async create(input: { socialAccountId: string; niche: string; audienceDescription?: string; tone?: string }) {
    const [row] = await this.db.insert(agentProfiles).values(input).returning();
    return row;
  }

  /** Most recently created active goal for a profile — a profile may have several historical goals. */
  async findActiveGoal(agentProfileId: string) {
    const [row] = await this.db
      .select()
      .from(agentGoals)
      .where(and(eq(agentGoals.agentProfileId, agentProfileId), eq(agentGoals.status, "active")))
      .orderBy(desc(agentGoals.createdAt))
      .limit(1);
    return row ?? null;
  }

  async createGoal(input: {
    agentProfileId: string;
    title: string;
    metric: string;
    targetValue?: number;
    deadline?: Date;
  }) {
    const [row] = await this.db
      .insert(agentGoals)
      .values({ ...input, targetValue: input.targetValue?.toString() })
      .returning();
    return row;
  }
}
