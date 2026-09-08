import { desc, eq } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { agentProfiles, experiments } from "../schema/index.js";
import { socialAccounts } from "../schema/core.js";

export class ExperimentRepository {
  constructor(private readonly db: DrizzleClient) {}

  async listForAccount(socialAccountId: string) {
    return this.db
      .select({ experiment: experiments })
      .from(experiments)
      .innerJoin(agentProfiles, eq(experiments.agentProfileId, agentProfiles.id))
      .innerJoin(socialAccounts, eq(agentProfiles.socialAccountId, socialAccounts.id))
      .where(eq(socialAccounts.id, socialAccountId))
      .orderBy(desc(experiments.createdAt));
  }

  async create(input: { agentProfileId: string; name: string; hypothesis?: string }) {
    const [row] = await this.db.insert(experiments).values(input).returning();
    return row;
  }
}
