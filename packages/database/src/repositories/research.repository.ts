import { desc, eq } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { researchFindings } from "../schema/index.js";

export interface CreateResearchFindingInput {
  socialAccountId: string;
  agentRunId: string;
  topic: string;
  relevanceScore: number;
  audienceInterestScore: number;
  competitionScore: number;
  rationale?: string;
  sourceType: string;
}

export class ResearchRepository {
  constructor(private readonly db: DrizzleClient) {}

  async createMany(inputs: CreateResearchFindingInput[]) {
    if (inputs.length === 0) return [];
    return this.db
      .insert(researchFindings)
      .values(
        inputs.map((input) => ({
          ...input,
          relevanceScore: input.relevanceScore.toString(),
          audienceInterestScore: input.audienceInterestScore.toString(),
          competitionScore: input.competitionScore.toString(),
        })),
      )
      .returning();
  }

  async listRecentByAccount(socialAccountId: string, limit = 20) {
    return this.db
      .select()
      .from(researchFindings)
      .where(eq(researchFindings.socialAccountId, socialAccountId))
      .orderBy(desc(researchFindings.createdAt))
      .limit(limit);
  }

  /** Findings produced by a specific run — used for the API response and idempotency checks. */
  async listByRunId(agentRunId: string) {
    return this.db.select().from(researchFindings).where(eq(researchFindings.agentRunId, agentRunId));
  }
}
