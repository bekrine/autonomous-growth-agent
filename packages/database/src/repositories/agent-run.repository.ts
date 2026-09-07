import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { agentActions, agentDecisions, agentRuns } from "../schema/index.js";
import type { AgentRunStatus } from "@agent/shared";

export class AgentRunRepository {
  constructor(private readonly db: Database) {}

  async create(socialAccountId: string) {
    const [row] = await this.db
      .insert(agentRuns)
      .values({ socialAccountId, status: "pending" })
      .returning();
    return row;
  }

  async markRunning(runId: string) {
    const [row] = await this.db
      .update(agentRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(agentRuns.id, runId))
      .returning();
    return row;
  }

  async markFinished(runId: string, status: Extract<AgentRunStatus, "completed" | "failed">, error?: string) {
    const [row] = await this.db
      .update(agentRuns)
      .set({ status, finishedAt: new Date(), error: error ?? null })
      .where(eq(agentRuns.id, runId))
      .returning();
    return row;
  }

  async findById(runId: string) {
    const [row] = await this.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    return row ?? null;
  }

  async listRecent(limit = 50) {
    return this.db.select().from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(limit);
  }

  async recordDecision(input: {
    agentRunId: string;
    agentName: string;
    decision: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }) {
    const [row] = await this.db
      .insert(agentDecisions)
      .values({
        agentRunId: input.agentRunId,
        agentName: input.agentName,
        decision: input.decision,
        reason: input.reason,
        metadata: input.metadata ?? {},
      })
      .returning();
    return row;
  }

  async recordAction(input: {
    agentRunId: string;
    agentDecisionId?: string;
    actionType: string;
    status: "pending" | "succeeded" | "failed";
    payload?: Record<string, unknown>;
    result?: unknown;
  }) {
    const [row] = await this.db
      .insert(agentActions)
      .values({
        agentRunId: input.agentRunId,
        agentDecisionId: input.agentDecisionId,
        actionType: input.actionType,
        status: input.status,
        payload: input.payload ?? {},
        result: input.result,
      })
      .returning();
    return row;
  }

  async listDecisions(agentRunId: string) {
    return this.db.select().from(agentDecisions).where(eq(agentDecisions.agentRunId, agentRunId));
  }

  async listActions(agentRunId: string) {
    return this.db.select().from(agentActions).where(eq(agentActions.agentRunId, agentRunId));
  }
}
